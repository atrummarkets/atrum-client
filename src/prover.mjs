/**
 * Main-thread handle for the proving worker.
 *
 * Keeps one worker alive across proofs rather than spawning per call: starting a worker
 * re-parses the 689KB snarkjs bundle, which is pure latency added to every action.
 *
 * The artefact buffers are TRANSFERRED, not copied. `bet_encrypted`'s zkey is 11.8MB and
 * structured-cloning it per proof would allocate that twice for no reason. Transferring
 * neuters the caller's copy, so the cache hands out a fresh slice each time.
 */

import { loadCircuit } from "./artifacts.mjs";

let worker = null;
let nextId = 1;
const pending = new Map();

function ensureWorker() {
  if (worker) return worker;

  worker = new Worker(new URL("./prover.worker.js", import.meta.url));
  worker.onmessage = (e) => {
    const { id, ok } = e.data;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(e.data);
    else entry.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => {
    // A worker-level failure kills every proof in flight; failing them individually leaves
    // callers hanging forever.
    for (const [, entry] of pending) entry.reject(new Error(e.message || "worker failed"));
    pending.clear();
  };

  return worker;
}

/**
 * Prove `name` over `input`, off the main thread.
 *
 * @returns {{proof, publicSignals, calldata, proveMs, cached}}
 */
export async function prove(name, input, { baseUrl, onProgress } = {}) {
  const { wasm, zkey, cached } = await loadCircuit(name, baseUrl, onProgress);
  const w = ensureWorker();

  // Copy before transferring: the cache may hand the same entry out again, and a transferred
  // buffer is left detached and unusable.
  const wasmBuf = wasm.slice().buffer;
  const zkeyBuf = zkey.slice().buffer;

  const id = nextId++;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));

  w.postMessage({ id, name, input, wasm: wasmBuf, zkey: zkeyBuf }, [wasmBuf, zkeyBuf]);

  return { ...(await result), cached };
}

/** Release the worker. Worth doing when a client is idle -- it holds the wasm instance. */
export function shutdown() {
  worker?.terminate();
  worker = null;
  pending.clear();
}
