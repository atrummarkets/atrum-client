// The full lifecycle: deposit, bet, redeem, withdraw -- each spending a note it did not
// create, producing one it does.
//
// The ordering is the same every time and it is load-bearing, not a style choice:
//   1. build the note the action produces
//   2. PERSIST it
//   3. prove
//   4. submit
//   5. only AFTER the transaction confirms, mark the note it spent as spent
//
// A note is the funds. If step 4 lands on chain while step 2 never happened, the payout is
// unspendable forever -- there is no account to recover it from. And marking a note spent
// before step 4 confirms is the opposite bug: a reverted transaction would silently orphan a
// note that was never actually spent.

import {
  createNote,
  createPositionNote,
  depositInput,
  betInput,
  redeemInput,
  withdrawInput,
  saveNote,
  markSpent,
  allNotes,
  exportNotes,
  noteRole,
  OUTCOME,
} from "./src/notes.mjs";
import { prove } from "./src/prover.mjs";
import { ethers } from "./public/vendor/ethers.min.js";
import {
  connect,
  marketInfo,
  poolInfo,
  rungInfo,
  rootAgeInfo,
  settlementInfo,
  committeeKey,
  submitDeposit,
  submitBet,
  submitRedeem,
  submitWithdraw,
  VAULT_OUTCOME,
  SHIELDED_POOL,
  readOnlyProvider,
} from "./src/wallet.mjs";
import { pathFor, waitForGraft, NotYetGrafted } from "./src/sequencer.mjs";
import * as core from "./public/vendor/atrum-core.mjs";

const $ = (id) => document.getElementById(id);
const log = (m) => {
  $("log").textContent += `\n${m}`;
  $("log").scrollTop = $("log").scrollHeight;
};

const OUTCOME_LABEL = { 0n: "unbet", 1n: "YES", 2n: "NO", 3n: "SETTLED" };
const short = (v) => `${v.toString().slice(0, 8)}…`;

let session = null;

// ---------------------------------------------------------------- notes table

async function refreshNoteCount() {
  const notes = await allNotes();
  $("note-count").textContent = notes.length
    ? `${notes.length} note(s) held on this device`
    : "no notes yet";
}

/**
 * Full withdrawal is what a user gets by just clicking the button -- the least private path,
 * since a lump-sum exit is the easiest pattern to correlate. Default to the largest rung
 * strictly below the note's value instead, so smaller withdrawals over time look like every
 * other deposit-sized amount. Not a hard limit: fall back to the full value on the smallest
 * rung, and nothing stops a user from typing the full amount back in.
 */
function defaultWithdrawAmount(units) {
  const v = BigInt(units);
  const smaller = core.snapToDenomination(v - 1n);
  return (smaller ?? v).toString();
}

async function renderNotes() {
  const notes = (await allNotes()).sort((a, b) => b.savedAt - a.savedAt);
  const body = $("notes-body");
  body.innerHTML = "";

  for (const note of notes) {
    const role = noteRole(note);
    const tr = document.createElement("tr");
    if (role === "spent") tr.className = "spent";

    const withdrawHtml =
      `<input class="amt" type="number" min="1" max="${note.units}" value="${defaultWithdrawAmount(note.units)}" data-amt="${note.id}"> ` +
      `<input class="recipient" type="text" placeholder="defaults to your connected wallet — see warning below" data-recipient="${note.id}"> ` +
      `<button class="small" data-act="withdraw" data-c="${note.id}">Withdraw</button>`;

    let actionHtml = '<span class="dim">—</span>';
    if (role === "bettable") {
      // An unbet note offers BOTH: it is bettable in any market and withdrawable right now,
      // because it is bound to no market and has nothing to wait for. Showing only the bet
      // buttons would hide the capability the shared pool exists to provide.
      actionHtml =
        `<button class="small" data-act="bet" data-side="1" data-c="${note.id}">Bet YES</button> ` +
        `<button class="small" data-act="bet" data-side="2" data-c="${note.id}">Bet NO</button> ` +
        withdrawHtml;
    } else if (role === "redeemable") {
      actionHtml = `<button class="small" data-act="redeem" data-c="${note.id}">Redeem</button>`;
    } else if (role === "withdrawable") {
      actionHtml = withdrawHtml;
    }

    // An unbet note carries NO_MARKET, which reads as a bare "0" and looks like market zero.
    // Name it, because "which market is this in" is the first question the column answers.
    const marketCell = note.outcome === 0n || note.outcome === "0"
      ? "any (unbet)"
      : note.marketId;

    tr.innerHTML =
      `<td title="${note.id}">${short(note.id)}</td>` +
      `<td>${marketCell}</td>` +
      `<td>${note.units}</td>` +
      `<td>${OUTCOME_LABEL[note.outcome] ?? note.outcome}</td>` +
      `<td>${role}</td>` +
      `<td>${actionHtml}</td>`;
    body.appendChild(tr);
  }

  await refreshNoteCount();
}

/**
 * A note's commitment is only spendable once the sequencer has grafted it, which happens on
 * its own batch cadence -- not instantly. A 400 here is the normal state right after an
 * action, not a failure, so this waits rather than erroring.
 */
async function pathForSpend(note) {
  try {
    return await pathFor(note.id);
  } catch (e) {
    if (!(e instanceof NotYetGrafted)) throw e;
    log(`  ${note.id.slice(0, 8)}… not grafted yet, waiting for the sequencer…`);
    return waitForGraft(note.id, {
      onWait: (s) => log(`  still waiting (${s}s left before giving up)…`),
    });
  }
}

// ---------------------------------------------------------------- bet

async function betOnNote(commitment, side) {
  const notes = await allNotes();
  const note = notes.find((n) => n.id === commitment);
  if (!note) return log(`no such note ${commitment}`);

  try {
    // The market comes from the dropdown, NOT from the note. An unbet note carries
    // NO_MARKET -- it is not in any market yet, and choosing which one is exactly what this
    // action does. Reading `note.marketId` here would stake every note into market 0.
    const marketId = BigInt($("market").value);
    if (marketId === 0n) return log("pick a market first");

    // Checked here as well as on chain. The chain rejects AFTER the user has paid for the
    // declared gas limit, and Monad bills the declared limit even on a revert -- so letting
    // this reach the contract costs real money to be told something readable off chain.
    const pool = await poolInfo(session.signer);
    if (!pool.canBet) {
      return log(
        `\ncannot bet yet: the pool has ${pool.totalDeposits} deposit(s) and needs `
        + `${pool.minAnonymitySet}. Betting into a crowd that small is not private, so the `
        + `contract refuses it. Deposit again, or wait for others.`,
      );
    }

    log(`\nbetting ${side === 1n ? "YES" : "NO"} in market ${marketId} with ${short(commitment)}…`);

    const pubKey = await committeeKey(session.signer, Number(marketId));
    const elgamal = await core.buildElGamal(pubKey);

    const path = await pathForSpend(note);

    // The root has to have aged before it can be spent, and a revert here costs the FULL
    // declared gas limit -- Monad bills the limit, not the usage. Checked before proving so a
    // two-minute wait stays a two-minute wait instead of becoming a paid failure.
    const age = await rootAgeInfo(session.signer, path.root);
    if (!age.ok) {
      return log(
        `\nthe note is grafted but its root is only ${age.age}s old; ${age.need}s is required. `
        + `Try again in ${age.waitSeconds}s. Spending a note out of the batch that created it `
        + `is what makes a deposit and its bet linkable by timing alone.`,
      );
    }

    const position = await createPositionNote({ marketId, units: note.units, outcome: side });
    await saveNote(position, { status: "unsubmitted", marketId: marketId.toString() });
    log(`  new position note ${short(position.commitment.toString())} saved locally`);

    const input = await betInput({ spend: note, position, path, elgamal });

    log("  proving in a worker…");
    const { calldata, proveMs } = await prove("bet_encrypted", input, {
      baseUrl: "./public/circuits",
      onProgress: (l, t, what) => {
        if (t) log(`    ${what} ${Math.round((l / t) * 100)}%`);
      },
    });
    log(`  proved in ${Math.round(proveMs)}ms`);

    const result = await submitBet({
      signer: session.signer,
      positionNote: position,
      calldata,
      marketId: Number(marketId),
      onStatus: (s) => log(`  ${s}`),
    });

    await markSpent(note.id, { spentTx: result.hash });
    await saveNote(position, {
      status: "deposited",
      marketId: marketId.toString(),
      txHash: result.hash,
      blockNumber: result.blockNumber,
    });

    log(`BET landed in block ${result.blockNumber}, gas ${result.gasUsed}`);
    log(result.explorer);
    await renderNotes();
  } catch (e) {
    const msg = e.shortMessage || e.reason || e.message;
    log(`\nBET FAILED: ${msg}`);
  }
}

// ---------------------------------------------------------------- redeem

async function redeemNote(commitment) {
  const notes = await allNotes();
  const note = notes.find((n) => n.id === commitment);
  if (!note) return log(`no such note ${commitment}`);

  try {
    log(`\nredeeming ${short(commitment)} (${OUTCOME_LABEL[note.outcome]})…`);

    const info = await settlementInfo(session.signer, Number(note.marketId));
    if (!info.vault) throw new Error(info.reason);
    if (info.outcome === VAULT_OUTCOME.UNRESOLVED) {
      throw new Error(`market ${note.marketId} has not been resolved yet`);
    }

    let totalPool, winningPool;
    if (info.outcome === VAULT_OUTCOME.VOID) {
      // Void refund: pinning totalPool == winningPool makes the circuit's division exactly
      // 1:1. Any equal nonzero pair works; the note's own units is a convenient one.
      totalPool = note.units;
      winningPool = note.units;
    } else {
      if (!info.settled) throw new Error(`market ${note.marketId} resolved but not settled yet`);
      totalPool = info.finalYesTotal + info.finalNoTotal;
      winningPool = info.outcome === VAULT_OUTCOME.YES ? info.finalYesTotal : info.finalNoTotal;
    }

    // Same division redeemInput will perform and verify -- computed here too, only so the
    // payout note can be built with the right units BEFORE calling it.
    const payout = (note.units * totalPool) / winningPool;

    const path = await pathForSpend(note);

    // Same reason as the bet path: a root-age revert costs the full declared gas limit, and
    // the fix is to wait, not to retry.
    const age = await rootAgeInfo(session.signer, path.root);
    if (!age.ok) {
      throw new Error(
        `the note's root is only ${age.age}s old; ${age.need}s is required. Try again in `
        + `${age.waitSeconds}s.`,
      );
    }


    const payoutNote = await createPositionNote({ marketId: note.marketId, units: payout, outcome: OUTCOME.SETTLED });
    await saveNote(payoutNote, { status: "unsubmitted", marketId: note.marketId.toString() });
    log(`  payout note ${short(payoutNote.commitment.toString())} (${payout} units) saved locally`);

    const input = redeemInput({ spend: note, payoutNote, path, totalPool, winningPool });

    log("  proving in a worker…");
    const { calldata, proveMs } = await prove("redeem_private", input, {
      baseUrl: "./public/circuits",
      onProgress: (l, t, what) => {
        if (t) log(`    ${what} ${Math.round((l / t) * 100)}%`);
      },
    });
    log(`  proved in ${Math.round(proveMs)}ms`);

    const result = await submitRedeem({
      signer: session.signer,
      payoutNote,
      calldata,
      marketId: Number(note.marketId),
      onStatus: (s) => log(`  ${s}`),
    });

    await markSpent(note.id, { spentTx: result.hash });
    await saveNote(payoutNote, {
      status: "deposited",
      marketId: note.marketId.toString(),
      txHash: result.hash,
      blockNumber: result.blockNumber,
    });

    log(`REDEEMED in block ${result.blockNumber}, gas ${result.gasUsed}`);
    log(result.explorer);
    await renderNotes();
  } catch (e) {
    const msg = e.shortMessage || e.reason || e.message;
    log(`\nREDEEM FAILED: ${msg}`);
  }
}

// ---------------------------------------------------------------- withdraw

async function withdrawNote(commitment, amountStr, recipientStr) {
  const notes = await allNotes();
  const note = notes.find((n) => n.id === commitment);
  if (!note) return log(`no such note ${commitment}`);

  const amount = BigInt(amountStr || "0");

  // Checked before any chain read or proof: a bad address should fail in milliseconds, not
  // after a 10+ second proof. Blank means "my own wallet" -- today's behaviour, unchanged.
  const recipientRaw = (recipientStr || "").trim();
  let recipient = session.address;
  if (recipientRaw) {
    if (!ethers.isAddress(recipientRaw)) {
      return log(`\nWITHDRAW FAILED: "${recipientRaw}" is not a valid address`);
    }
    recipient = ethers.getAddress(recipientRaw);
  }

  try {
    log(`\nwithdrawing ${amount} of ${short(commitment)} to `
      + `${recipient === session.address ? "your connected wallet" : `fresh address ${recipient}`}…`);
    if (amount <= 0n || amount > note.units) {
      throw new Error(`amount must be between 1 and ${note.units}`);
    }

    // The withdrawn amount is PUBLIC. A rung nobody else has used is an identifier, not a
    // denomination, so the chain refuses it -- caught here for a readable reason.
    const rung = await rungInfo(session.signer, amount);
    if (!rung.ok) {
      throw new Error(
        `${amount} is too rare a size to withdraw privately: ${rung.count} deposit(s) have `
        + `used it, ${rung.need} needed. Withdrawing it would name you regardless of the proof.`,
      );
    }

    const change = note.units - amount;
    const path = await pathForSpend(note);

    // Same reason as the bet path: a root-age revert costs the full declared gas limit, and
    // the fix is to wait, not to retry.
    const age = await rootAgeInfo(session.signer, path.root);
    if (!age.ok) {
      throw new Error(
        `the note's root is only ${age.age}s old; ${age.need}s is required. Try again in `
        + `${age.waitSeconds}s.`,
      );
    }


    // The change note mirrors the note being spent on BOTH marketId and outcome, because
    // `withdraw.circom` builds it from the same signals. A SETTLED payout's change stays
    // SETTLED; an unbet note's change stays UNBET, and so stays bettable as well as
    // withdrawable.
    const changeNote = await createPositionNote({
      marketId: note.marketId,
      units: change,
      outcome: note.outcome,
    });
    await saveNote(changeNote, { status: "unsubmitted", marketId: note.marketId.toString() });
    log(`  change note ${short(changeNote.commitment.toString())} (${change} units) saved locally`);

    const input = withdrawInput({ spend: note, recipient, amount, changeNote, path });

    log("  proving in a worker…");
    const { calldata, proveMs } = await prove("withdraw", input, {
      baseUrl: "./public/circuits",
      onProgress: (l, t, what) => {
        if (t) log(`    ${what} ${Math.round((l / t) * 100)}%`);
      },
    });
    log(`  proved in ${Math.round(proveMs)}ms`);

    const result = await submitWithdraw({
      signer: session.signer,
      changeNote,
      calldata,
      marketId: Number(note.marketId),
      onStatus: (s) => log(`  ${s}`),
    });

    await markSpent(note.id, { spentTx: result.hash });
    await saveNote(changeNote, {
      status: "deposited",
      marketId: note.marketId.toString(),
      txHash: result.hash,
      blockNumber: result.blockNumber,
    });

    log(`WITHDRAWN ${amount} units in block ${result.blockNumber}, gas ${result.gasUsed}`);
    log(result.explorer);
    await renderNotes();
  } catch (e) {
    const msg = e.shortMessage || e.reason || e.message;
    log(`\nWITHDRAW FAILED: ${msg}`);
  }
}

$("notes-body").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !session) return;

  const act = btn.dataset.act;
  const c = btn.dataset.c;
  if (act === "bet") betOnNote(c, BigInt(btn.dataset.side));
  else if (act === "redeem") redeemNote(c);
  else if (act === "withdraw") {
    const amtInput = document.querySelector(`input[data-amt="${c}"]`);
    const recipientInput = document.querySelector(`input[data-recipient="${c}"]`);
    withdrawNote(c, amtInput?.value, recipientInput?.value);
  }
});

$("refresh-notes").onclick = renderNotes;
$("refresh-markets").onclick = loadMarkets;


// ---------------------------------------------------------------- wallet + deposit

/**
 * Guards against a stale market read winning a race.
 *
 * `showMarket` reads the selected market, then makes several chain calls before deciding
 * whether the deposit button should be enabled. Switch markets while one is in flight and two
 * overlap — whichever resolves LAST writes the button state, which may be the one describing
 * the market you just navigated away from. The symptom is a deposit button disabled for an
 * open market (or worse, enabled for a closed one) with no way to tell why.
 */
let marketReadSeq = 0;

async function showMarket() {
  if (!session) return;
  const seq = ++marketReadSeq;
  const marketId = Number($("market").value);
  const dl = $("market-info");
  dl.innerHTML = '<dt>reading…</dt><dd></dd>';

  // Only the most recent read may touch the DOM.
  const current = () => seq === marketReadSeq;

  try {
    const info = await marketInfo(session.signer, marketId);
    if (!current()) return;

    if (!info.vault) {
      dl.innerHTML = `<dt class="bad">unavailable</dt><dd>${info.reason}</dd>`;
      return;
    }

    dl.innerHTML = `
      <dt>vault</dt><dd>${info.vaultAddress}</dd>
      <dt>encrypted</dt><dd>${info.encrypted ? "yes" : "no — plaintext market"}</dd>
      <dt>betting</dt><dd class="${info.closed ? "bad" : "ok"}">${info.closed ? "CLOSED" : "open"}</dd>`;
    // Deliberately does NOT touch the deposit button. A deposit names no market, so gating it
    // on a market's betting deadline would block the one action that has no deadline -- and
    // would strand a user whose only open market had just closed.
  } catch (e) {
    if (!current()) return;
    dl.innerHTML = `<dt class="bad">error</dt><dd>${e.message}</dd>`;
  }
}

$("connect").onclick = async () => {
  try {
    session = await connect();
    $("account").textContent = session.address;
    $("account").className = "ok";
    log(`connected ${session.address}`);
    log(`pool ${SHIELDED_POOL}`);
    await showPool();
    await showMarket();
    await renderNotes();
  } catch (e) {
    log(`connect failed: ${e.message}`);
  }
};

/**
 * Everything a DEPOSIT depends on, which is nothing about a market.
 *
 * The deposit button is enabled from here and nowhere else. Enabling it from `showMarket`
 * (as it used to be) meant a closed market disabled the one action that has no deadline.
 */
async function showPool() {
  const dl = $("pool-info");
  dl.innerHTML = '<dt>reading…</dt><dd></dd>';
  try {
    const info = await poolInfo(session.signer);
    const balance = await info.collateral.balanceOf(session.address);

    // Stated as an UPPER BOUND, because that is what it is. The counter never decrements --
    // it cannot, since decrementing would mean observing which notes are still unspent, and
    // that is the fact the pool exists to hide. Rounding this up into "N people are hiding
    // you" would be a claim the contract cannot support.
    const crowd = info.canBet
      ? `<span class="ok">${info.totalDeposits}</span> deposits, at most that many notes look `
        + `like yours (${info.minAnonymitySet} needed to bet)`
      : `<span class="bad">${info.totalDeposits} of ${info.minAnonymitySet}</span> — betting is `
        + `blocked until the pool has a crowd to hide you in`;

    dl.innerHTML = `
      <dt>pool</dt><dd>${SHIELDED_POOL}</dd>
      <dt>collateral</dt><dd>${info.collateralAddress} (${info.symbol})</dd>
      <dt>denomination</dt><dd>${info.denomination}</dd>
      <dt>anonymity set</dt><dd>${crowd}</dd>
      <dt>your balance</dt><dd>${balance}</dd>`;

    // Depositing is never gated. Gating it would deadlock the pool: nobody could deposit
    // until enough deposits existed.
    $("deposit").disabled = false;
  } catch (e) {
    dl.innerHTML = `<dt class="bad">error</dt><dd>${e.message}</dd>`;
    $("deposit").disabled = true;
  }
}

$("market").onchange = showMarket;

$("deposit").onclick = async () => {
  if (!session) return log("connect a wallet first");

  $("deposit").disabled = true;
  try {
    const units = BigInt($("units").value);

    // The chain enforces this, but it rejects AFTER the user has paid for the declared gas
    // limit -- and Monad bills the declared limit even on a revert. Catch it here instead.
    if (!core.isValidDenomination(units)) {
      throw new Error(`${units} is not a denomination: ${core.DENOMINATIONS.join(", ")}`);
    }

    // No market. The note this creates can back a bet in ANY market, or be withdrawn without
    // ever backing one -- which is why the market dropdown above does not gate a deposit.
    log(`\ncreating an unbet note for ${units} units…`);
    const note = await createNote({ units });
    log(`  commitment ${note.commitment}`);

    // Before proving, before broadcasting. See the note at the top of this file.
    await saveNote(note, { status: "unsubmitted", marketId: note.marketId.toString() });
    await renderNotes();
    log("  saved locally (export it — losing it loses the funds)");

    log("proving in a worker…");
    const t0 = performance.now();
    const { calldata, proveMs, cached } = await prove("deposit", depositInput(note), {
      baseUrl: "./public/circuits",
      onProgress: (l, t, what) => {
        if (t) log(`  ${what} ${Math.round((l / t) * 100)}%`);
      },
    });
    log(`  proved in ${Math.round(proveMs)}ms (artefacts ${cached ? "cached" : "downloaded"}), `
      + `${Math.round(performance.now() - t0)}ms total`);

    const result = await submitDeposit({
      signer: session.signer,
      note,
      calldata,
      onStatus: (s) => log(`  ${s}`),
    });

    await saveNote(note, {
      status: "deposited",
      marketId: note.marketId.toString(),
      txHash: result.hash,
      blockNumber: result.blockNumber,
    });

    log(`\nDEPOSITED in block ${result.blockNumber}, gas used ${result.gasUsed}`);
    log(result.explorer);
    log(
      "\nThe sequencer batches commitments, so this note is not spendable until it is grafted "
      + "into the tree — usually within a minute.",
    );
    await renderNotes();
  } catch (e) {
    // Wallet rejections are a normal user action, not a failure worth a stack trace.
    const msg = e.shortMessage || e.reason || e.message;
    log(`\nFAILED: ${msg}`);
    if (e.data) log(`  revert data: ${e.data}`);
  } finally {
    $("deposit").disabled = false;
  }
};

$("export").onclick = async () => {
  const json = await exportNotes();
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `atrum-notes-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  log(`\nexported ${(await allNotes()).length} note(s)`);
};

// ---------------------------------------------------------------- markets registry

const fmtTime = (unixSec) => new Date(unixSec * 1000).toLocaleString();

/**
 * markets.json, written by atrum-core's create-market.mjs. There is no on-chain way to
 * enumerate "all markets" -- ShieldedPool has marketVault[id] lookups, not a list -- and this
 * project's own rule is never build on eth_getLogs (100-block range cap on the public RPC).
 * A committed registry is the alternative that needs no chain scanning.
 */
const OUTCOME_NAME = ["Unresolved", "YES", "NO", "Void"];

async function loadMarkets() {
  let registry;
  try {
    registry = await (await fetch("./markets.json")).json();
  } catch {
    $("markets-body").innerHTML =
      '<tr><td colspan="6" class="dim">no markets.json — run create-market.mjs in atrum-core</td></tr>';
    return;
  }

  if (registry.pool && registry.pool.toLowerCase() !== SHIELDED_POOL.toLowerCase()) {
    log(`\nwarning: markets.json is for pool ${registry.pool}, this page points at ${SHIELDED_POOL}`);
  }

  const markets = registry.markets ?? [];
  const select = $("market");
  const body = $("markets-body");

  if (!markets.length) {
    select.innerHTML = "";
    body.innerHTML = '<tr><td colspan="6" class="dim">no markets yet — run create-market.mjs</td></tr>';
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  select.innerHTML = markets
    .map((m) => `<option value="${m.id}">#${m.id} — ${m.question}</option>`)
    .join("");

  body.innerHTML = markets
    .map((m) => {
      const closed = now >= m.bettingCloseTime;
      return (
        `<tr data-market-row="${m.id}"><td>${m.id}</td><td>${m.question}</td><td>${m.type}</td>` +
        `<td class="${closed ? "bad" : "ok"}">${closed ? "closed" : "open"} (${fmtTime(m.bettingCloseTime)})</td>` +
        `<td class="dim">reading…</td><td class="dim">reading…</td></tr>`
      );
    })
    .join("");

  // Resolved/settled is PUBLIC chain state -- read-only, needs no wallet connection. Each
  // market gets its own row rather than one shared status block, so nothing implies the
  // status shown belongs to whichever market happens to be selected elsewhere on the page.
  // SEQUENTIAL, not Promise.all. Each settlementInfo is ~8 chain reads, so firing every
  // market at once is a burst that the public RPC answers with HTTP 429 -- which then
  // surfaces as "missing revert data" on a market that is perfectly fine. Markets are few
  // and this is not latency-critical; the retry/backoff in wallet.mjs handles what is left.
  const provider = readOnlyProvider();
  for (const m of markets) {
    await (async () => {
      const row = document.querySelector(`tr[data-market-row="${m.id}"]`);
      if (!row) return;
      const [, , , , resolvedCell, settledCell] = row.children;
      try {
        const info = await settlementInfo(provider, m.id, registry.pool ?? SHIELDED_POOL);
        if (!info.vault) {
          resolvedCell.textContent = "unavailable";
          settledCell.textContent = info.reason ?? "";
          return;
        }
        const outcome = Number(info.outcome);
        resolvedCell.textContent = OUTCOME_NAME[outcome];
        resolvedCell.className = outcome === 0 ? "bad" : "ok";
        settledCell.textContent = info.settled
          ? info.finalYesTotal !== undefined
            ? `yes (YES ${info.finalYesTotal} / NO ${info.finalNoTotal})`
            : "yes"
          : "no";
        settledCell.className = info.settled ? "ok" : "dim";
      } catch (e) {
        resolvedCell.textContent = "error";
        resolvedCell.className = "bad";
        settledCell.textContent = e.message;
      }
    })();
  }
}

await core.init();
await renderNotes();
await loadMarkets();
log("ready — connect a wallet to begin");
