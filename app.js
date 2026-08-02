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
import {
  connect,
  marketInfo,
  settlementInfo,
  committeeKey,
  submitDeposit,
  submitBet,
  submitRedeem,
  submitWithdraw,
  VAULT_OUTCOME,
  SHIELDED_POOL,
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

async function renderNotes() {
  const notes = (await allNotes()).sort((a, b) => b.savedAt - a.savedAt);
  const body = $("notes-body");
  body.innerHTML = "";

  for (const note of notes) {
    const role = noteRole(note);
    const tr = document.createElement("tr");
    if (role === "spent") tr.className = "spent";

    let actionHtml = '<span class="dim">—</span>';
    if (role === "bettable") {
      actionHtml =
        `<button class="small" data-act="bet" data-side="1" data-c="${note.id}">Bet YES</button> ` +
        `<button class="small" data-act="bet" data-side="2" data-c="${note.id}">Bet NO</button>`;
    } else if (role === "redeemable") {
      actionHtml = `<button class="small" data-act="redeem" data-c="${note.id}">Redeem</button>`;
    } else if (role === "withdrawable") {
      actionHtml =
        `<input class="amt" type="number" min="1" max="${note.units}" value="${note.units}" data-amt="${note.id}"> ` +
        `<button class="small" data-act="withdraw" data-c="${note.id}">Withdraw</button>`;
    }

    tr.innerHTML =
      `<td title="${note.id}">${short(note.id)}</td>` +
      `<td>${note.marketId}</td>` +
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
    log(`\nbetting ${side === 1n ? "YES" : "NO"} with ${short(commitment)}…`);

    const pubKey = await committeeKey(session.signer, Number(note.marketId));
    const elgamal = await core.buildElGamal(pubKey);

    const path = await pathForSpend(note);

    const position = await createPositionNote({ marketId: note.marketId, units: note.units, outcome: side });
    await saveNote(position, { status: "unsubmitted", marketId: note.marketId.toString() });
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
      marketId: Number(note.marketId),
      onStatus: (s) => log(`  ${s}`),
    });

    await markSpent(note.id, { spentTx: result.hash });
    await saveNote(position, {
      status: "deposited",
      marketId: note.marketId.toString(),
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

async function withdrawNote(commitment, amountStr) {
  const notes = await allNotes();
  const note = notes.find((n) => n.id === commitment);
  if (!note) return log(`no such note ${commitment}`);

  const amount = BigInt(amountStr || "0");

  try {
    log(`\nwithdrawing ${amount} of ${short(commitment)}…`);
    if (amount <= 0n || amount > note.units) {
      throw new Error(`amount must be between 1 and ${note.units}`);
    }

    const change = note.units - amount;
    const path = await pathForSpend(note);

    const changeNote = await createPositionNote({ marketId: note.marketId, units: change, outcome: OUTCOME.SETTLED });
    await saveNote(changeNote, { status: "unsubmitted", marketId: note.marketId.toString() });
    log(`  change note ${short(changeNote.commitment.toString())} (${change} units) saved locally`);

    const input = withdrawInput({ spend: note, recipient: session.address, amount, changeNote, path });

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
    const input = document.querySelector(`input[data-amt="${c}"]`);
    withdrawNote(c, input?.value);
  }
});

$("refresh-notes").onclick = renderNotes;

// ---------------------------------------------------------------- settlement status

$("refresh-settlement").onclick = async () => {
  if (!session) return log("connect a wallet first");
  const marketId = Number($("market").value);
  const dl = $("settlement-info");
  dl.innerHTML = "<dt>reading…</dt><dd></dd>";

  try {
    const info = await settlementInfo(session.signer, marketId);
    if (!info.vault) {
      dl.innerHTML = `<dt class="bad">unavailable</dt><dd>${info.reason}</dd>`;
      return;
    }
    const outcomeLabel = ["Unresolved", "YES", "NO", "Void"][Number(info.outcome)];
    dl.innerHTML =
      `<dt>resolved</dt><dd class="${info.outcome === VAULT_OUTCOME.UNRESOLVED ? "bad" : "ok"}">${outcomeLabel}</dd>` +
      `<dt>settled</dt><dd class="${info.settled ? "ok" : "dim"}">${info.settled}</dd>` +
      (info.finalYesTotal !== undefined
        ? `<dt>final YES</dt><dd>${info.finalYesTotal}</dd><dt>final NO</dt><dd>${info.finalNoTotal}</dd>`
        : "");
  } catch (e) {
    dl.innerHTML = `<dt class="bad">error</dt><dd>${e.message}</dd>`;
  }
};

// ---------------------------------------------------------------- wallet + deposit

async function showMarket() {
  if (!session) return;
  const marketId = Number($("market").value);
  const dl = $("market-info");
  dl.innerHTML = '<dt>reading…</dt><dd></dd>';

  try {
    const info = await marketInfo(session.signer, marketId);
    if (!info.vault) {
      dl.innerHTML = `<dt class="bad">unavailable</dt><dd>${info.reason}</dd>`;
      $("deposit").disabled = true;
      return;
    }

    const balance = await info.collateral.balanceOf(session.address);
    dl.innerHTML = `
      <dt>vault</dt><dd>${info.vaultAddress}</dd>
      <dt>collateral</dt><dd>${info.collateralAddress} (${info.symbol})</dd>
      <dt>denomination</dt><dd>${info.denomination}</dd>
      <dt>encrypted</dt><dd>${info.encrypted ? "yes" : "no — plaintext market"}</dd>
      <dt>betting</dt><dd class="${info.closed ? "bad" : "ok"}">${info.closed ? "CLOSED" : "open"}</dd>
      <dt>your balance</dt><dd>${balance}</dd>`;
    $("deposit").disabled = info.closed;
  } catch (e) {
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
    await showMarket();
    await renderNotes();
  } catch (e) {
    log(`connect failed: ${e.message}`);
  }
};

$("market").onchange = showMarket;

$("deposit").onclick = async () => {
  if (!session) return log("connect a wallet first");

  $("deposit").disabled = true;
  try {
    const marketId = BigInt($("market").value);
    const units = BigInt($("units").value);

    // The chain enforces this, but it rejects AFTER the user has paid for the declared gas
    // limit -- and Monad bills the declared limit even on a revert. Catch it here instead.
    if (!core.isValidDenomination(units)) {
      throw new Error(`${units} is not a denomination: ${core.DENOMINATIONS.join(", ")}`);
    }

    log(`\ncreating a note for market ${marketId}, ${units} units…`);
    const note = await createNote({ marketId, units });
    log(`  commitment ${note.commitment}`);

    // Before proving, before broadcasting. See the note at the top of this file.
    await saveNote(note, { status: "unsubmitted", marketId: marketId.toString() });
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
      marketId: Number(marketId),
      onStatus: (s) => log(`  ${s}`),
    });

    await saveNote(note, {
      status: "deposited",
      marketId: marketId.toString(),
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

await core.init();
await renderNotes();
log("ready — connect a wallet to begin");
