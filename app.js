// Deposit, end to end: create a note, prove it in a worker, submit it on chain.
//
// The ordering here is deliberate and load-bearing:
//   1. create the note
//   2. PERSIST it
//   3. prove
//   4. submit
//
// The note is saved before anything is broadcast because a note is the funds. If a deposit
// lands on chain while its nullifier and secret existed only in a variable, the collateral is
// unspendable forever -- there is no account to recover it from and nothing on chain to
// reconstruct it from.

import { createNote, depositInput, saveNote, allNotes, exportNotes } from "./src/notes.mjs";
import { prove } from "./src/prover.mjs";
import { connect, marketInfo, submitDeposit, SHIELDED_POOL } from "./src/wallet.mjs";
import * as core from "./public/vendor/atrum-core.mjs";

const $ = (id) => document.getElementById(id);
const log = (m) => {
  $("log").textContent += `\n${m}`;
  $("log").scrollTop = $("log").scrollHeight;
};

let session = null;

async function refreshNoteCount() {
  const notes = await allNotes();
  $("note-count").textContent = notes.length
    ? `${notes.length} note(s) held on this device`
    : "no notes yet";
}

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
    await refreshNoteCount();
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
    await refreshNoteCount();
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
await refreshNoteCount();
log("ready — connect a wallet to begin");
