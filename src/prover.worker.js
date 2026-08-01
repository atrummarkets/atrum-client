/**
 * Groth16 proving, off the main thread.
 *
 * MEASURED, NOT ASSUMED. `bet_encrypted` holds the main thread for 388ms when proved
 * inline, and every circuit exceeds 100ms -- requestAnimationFrame simply stops firing while
 * the thread is blocked, so that gap is the freeze a user sees. The browser multiplier
 * (~2-2.5x Node) would have been survivable on its own; the stall is what made this
 * mandatory. See atrum-core HANDOFF.md section 0-bis.
 *
 * The worker owns snarkjs entirely. Nothing here touches the DOM, and the artefacts arrive
 * as transferred ArrayBuffers so the 11.8MB zkey is moved rather than copied.
 */

importScripts("../public/vendor/snarkjs.min.js");

self.onmessage = async (e) => {
  const { id, name, input, wasm, zkey } = e.data;

  try {
    const t0 = performance.now();
    const { proof, publicSignals } = await self.snarkjs.groth16.fullProve(
      input,
      new Uint8Array(wasm),
      new Uint8Array(zkey),
    );
    const proveMs = performance.now() - t0;

    // Solidity calldata, built HERE rather than by the caller, because snarkjs swaps each G2
    // coordinate pair in exportSolidityCallData relative to the raw proof object. Building
    // calldata from `proof` directly yields a well-formed proof that reverts on chain --
    // see gen_action_fixtures.mjs:88-94 in atrum-core.
    const calldata = await self.snarkjs.groth16.exportSolidityCallData(proof, publicSignals);

    self.postMessage({ id, ok: true, name, proof, publicSignals, calldata, proveMs });
  } catch (error) {
    self.postMessage({ id, ok: false, name, error: error.message });
  }
};
