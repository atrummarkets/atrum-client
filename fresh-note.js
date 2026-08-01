// Prove a deposit from a note this client invented, and verify it against the circuit's vkey.
//
// This is the check that matters. A client-built witness against a repo-built circuit is
// exactly the seam where every real bug in this project has lived -- queuePadding, the
// `units == 0` guard that vanished at the Solidity/circuit boundary, the committee key that
// went stale. All three were correct components joined by an untested seam.
//
// Deposit is the right action to test it with: its public signals are just
// [commitment, marketId, units], so nothing here depends on a running sequencer, a funded
// wallet, or a chain. If the commitment the client derives disagrees with note.circom by a
// single bit, the proof does not satisfy the constraints and this fails.

import { createNote, depositInput, saveNote, allNotes, exportNotes } from "./src/notes.mjs";
import { prove } from "./src/prover.mjs";
import * as core from "./public/vendor/atrum-core.mjs";

const $ = (id) => document.getElementById(id);
const log = (m) => {
  $("log").textContent += `\n${m}`;
  $("log").scrollTop = $("log").scrollHeight;
};

$("run").onclick = async () => {
  $("run").disabled = true;
  $("log").textContent = "generating a note from fresh randomness…";

  try {
    await core.init();

    const marketId = 8n; // an encrypted market on the live deployment
    const units = 100n; // a valid denomination

    const note = await createNote({ marketId, units });

    log(`\nnote created entirely in this browser:`);
    log(`  marketId   : ${note.marketId}`);
    log(`  units      : ${note.units}`);
    log(`  outcome    : ${note.outcome} (unbet collateral)`);
    log(`  nullifier  : ${note.nullifier.toString().slice(0, 24)}…  (secret)`);
    log(`  secret     : ${note.secret.toString().slice(0, 24)}…  (secret)`);
    log(`  commitment : ${note.commitment}`);

    // Persist BEFORE anything else. On the real path this happens before broadcasting: a
    // deposit that lands on chain while its note existed only in a variable is money burned.
    await saveNote(note, { status: "unsubmitted" });
    log(`\nsaved to IndexedDB (${(await allNotes()).length} note(s) held)`);

    log(`\ndenomination check: ${core.isValidDenomination(units) ? "valid" : "INVALID"}`);

    const input = depositInput(note);
    log("\nwitness built by the client, not by the repo. proving…");
    $("status").textContent = "proving…";

    const t0 = performance.now();
    const { proof, publicSignals, calldata, proveMs, cached } = await prove("deposit", input, {
      baseUrl: "./public/circuits",
      onProgress: (l, t, what) => {
        if (t) $("status").textContent = `${what} ${Math.round((l / t) * 100)}%`;
      },
    });
    const wallMs = performance.now() - t0;
    $("status").textContent = "";

    log(`proved in ${Math.round(proveMs)}ms (${Math.round(wallMs)}ms wall, artefacts ${cached ? "cached" : "downloaded"})`);

    // The circuit's own verification key. Passing here means the witness satisfied every
    // constraint in deposit.circom -- including the commitment binding.
    const vkey = await (await fetch("./public/circuits/deposit/deposit_vkey.json")).json();
    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);

    log(`\npublic signals: [${publicSignals.join(", ")}]`);

    // The circuit must have arrived at the same commitment the client did.
    const signalsMatch =
      BigInt(publicSignals[0]) === note.commitment &&
      BigInt(publicSignals[1]) === note.marketId &&
      BigInt(publicSignals[2]) === note.units;

    log(`\nverified against deposit_vkey.json : ${ok ? "YES" : "NO"}`);
    log(`public signals match the note       : ${signalsMatch ? "YES" : "NO"}`);
    log(`Solidity calldata produced          : ${calldata?.length > 0 ? "YES" : "NO"}`);

    if (ok && signalsMatch) {
      log(
        "\nVERDICT: the client's commitment derivation agrees with note.circom.\n" +
          "The witness-building seam is sound. What remains untested is only the on-chain\n" +
          "submission, which needs a funded key.",
      );
    } else {
      log("\nVERDICT: MISMATCH. The client and the circuit disagree — do not submit anything.");
    }

    window.__freshNote = {
      ok,
      signalsMatch,
      hasCalldata: calldata?.length > 0,
      commitment: note.commitment.toString(),
      publicSignals,
      proveMs,
      // Everything needed to submit this deposit by hand, once a funded key exists.
      calldata,
    };

    log("\n--- exportable note bundle (this is the money; losing it loses the funds) ---");
    log(await exportNotes());
  } catch (e) {
    log(`\nFATAL: ${e.message}`);
    window.__freshNoteError = e.message;
  } finally {
    window.__freshNoteDone = true;
    $("run").disabled = false;
  }
};
