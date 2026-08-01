// A/B: prove bet_encrypted inline, then in the worker, measuring the frame stall each time.
//
// The point is not the proving time -- that barely moves, and should not. The worker does not
// make proving faster; it makes the page stay alive while it happens. So the column that
// matters is the stall, and the claim being tested is narrow and falsifiable: inline freezes
// the main thread for hundreds of milliseconds, in the worker it does not.

import { prove } from "./src/prover.mjs";
import { loadCircuit } from "./src/artifacts.mjs";

const CIRCUIT = "bet_encrypted";

const $ = (id) => document.getElementById(id);
const log = (m) => {
  $("log").textContent += `\n${m}`;
  $("log").scrollTop = $("log").scrollHeight;
};
const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

/** requestAnimationFrame stops firing while the main thread is blocked; the gap is the freeze. */
function startFrameMonitor() {
  let last = performance.now();
  let max = 0;
  let running = true;
  const tick = () => {
    if (!running) return;
    const now = performance.now();
    if (now - last > max) max = now - last;
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => {
    running = false;
    return max;
  };
}

function addRow(mode, proveMs, stallMs, verified) {
  const tr = document.createElement("tr");
  const frozen = stallMs > 100;
  tr.innerHTML =
    `<td><code>${mode}</code></td>` +
    `<td>${fmt(proveMs)}</td>` +
    `<td class="${frozen ? "bad" : "ok"}">${fmt(stallMs)}</td>` +
    `<td class="${frozen ? "bad" : "ok"}">${frozen ? "frozen" : "responsive"}</td>` +
    `<td class="${verified ? "ok" : "bad"}">${verified ? "ok" : "FAILED"}</td>`;
  $("rows").appendChild(tr);
}

async function verify(proof, publicSignals) {
  const vkey = await (
    await fetch(`./public/circuits/${CIRCUIT}/${CIRCUIT}_vkey.json`)
  ).json();
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

$("run").onclick = async () => {
  $("run").disabled = true;
  $("rows").innerHTML = "";
  $("log").textContent = "loading fixture input…";

  try {
    const inputs = await (await fetch("./public/fixtures/witness-inputs.json")).json();
    const input = inputs[CIRCUIT];

    // Warm the cache first so neither run pays for the 11.8MB download. Measuring a fetch as
    // if it were proving would flatter whichever mode ran second.
    log("warming the artefact cache…");
    const { wasm, zkey, cached } = await loadCircuit(CIRCUIT, "./public/circuits", (l, t, what) => {
      if (t) $("status").textContent = `${what} ${Math.round((l / t) * 100)}%`;
    });
    log(`artefacts ready (${cached ? "from IndexedDB" : "downloaded, now cached"})`);
    $("status").textContent = "";

    // ---- inline, on the main thread
    log("\nproving inline, on the main thread…");
    await new Promise((r) => setTimeout(r, 50));
    let stop = startFrameMonitor();
    let t0 = performance.now();
    const inline = await snarkjs.groth16.fullProve(input, wasm.slice(), zkey.slice());
    const inlineMs = performance.now() - t0;
    const inlineStall = stop();
    const inlineOk = await verify(inline.proof, inline.publicSignals);
    addRow("main thread", inlineMs, inlineStall, inlineOk);
    log(`inline: proved in ${fmt(inlineMs)}, longest stall ${fmt(inlineStall)}`);

    // ---- in the worker
    log("\nproving in the worker…");
    await new Promise((r) => setTimeout(r, 50));
    stop = startFrameMonitor();
    const workerResult = await prove(CIRCUIT, input, { baseUrl: "./public/circuits" });
    const workerStall = stop();
    const workerOk = await verify(workerResult.proof, workerResult.publicSignals);
    addRow("web worker", workerResult.proveMs, workerStall, workerOk);
    log(`worker: proved in ${fmt(workerResult.proveMs)}, longest stall ${fmt(workerStall)}`);

    // The worker also builds Solidity calldata, because snarkjs swaps G2 coordinate pairs in
    // exportSolidityCallData relative to the raw proof -- doing it anywhere else invites
    // someone to build calldata from `proof` and get a proof that reverts on chain.
    const hasCalldata = typeof workerResult.calldata === "string" && workerResult.calldata.length > 0;
    log(`worker returned Solidity calldata: ${hasCalldata ? "yes" : "NO"}`);

    log("\n———");
    log(`stall inline : ${fmt(inlineStall)}`);
    log(`stall worker : ${fmt(workerStall)}`);
    log(
      workerStall < 100 && inlineStall > 100
        ? "VERDICT: the worker fixes it. The page stays responsive while proving."
        : "VERDICT: inconclusive — see the numbers above.",
    );

    window.__abResults = {
      inline: { proveMs: inlineMs, stallMs: inlineStall, verified: inlineOk },
      worker: { proveMs: workerResult.proveMs, stallMs: workerStall, verified: workerOk, hasCalldata },
    };
    $("status").textContent = "done";
  } catch (e) {
    log(`\nFATAL: ${e.message}`);
    window.__abError = e.message;
    $("status").textContent = "failed";
  } finally {
    window.__abDone = true;
    $("run").disabled = false;
  }
};
