// Re-measure Node proving time on THIS machine, against the synced artefacts.
//
// WHY THIS EXISTS: the browser multiplier is only meaningful if both halves are measured on
// the same hardware. atrum-core's HANDOFF.md records Node timings (deposit 322ms,
// bet_encrypted 2,255ms, redeem_private 1,437ms, withdraw 1,411ms) from one machine on one
// day. Dividing a browser number measured here by a Node number measured there produces a
// ratio that describes the two machines as much as the two runtimes.
//
// It doubles as the harness's correctness gate: it proves and verifies every circuit against
// the same files public/ serves, so a fixture that no longer matches a rebuilt circuit fails
// here in seconds rather than after a 30MB download in a browser tab.
//
// Usage: npm run baseline

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as snarkjs from 'snarkjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');

// Node baselines recorded in atrum-core HANDOFF.md, kept only for comparison against what
// this machine actually does.
const CIRCUITS = [
  { name: 'deposit', handoffMs: 322 },
  { name: 'bet_encrypted', handoffMs: 2255 },
  { name: 'redeem_private', handoffMs: 1437 },
  { name: 'withdraw', handoffMs: 1411 },
];

const inputs = JSON.parse(
  readFileSync(join(PUBLIC, 'fixtures', 'witness-inputs.json'), 'utf8'),
);

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

console.log('\nNode proving baseline, measured on this machine');
console.log('='.repeat(64));
console.log(
  'circuit'.padEnd(16) + 'prove'.padStart(10) + 'verify'.padStart(10)
  + 'HANDOFF'.padStart(10) + 'drift'.padStart(10) + '  ok',
);
console.log('-'.repeat(64));

let failed = 0;
const measured = {};

for (const { name, handoffMs } of CIRCUITS) {
  const base = join(PUBLIC, 'circuits', name, name);
  const input = inputs[name];

  if (!input) {
    console.log(`${name.padEnd(16)}${'no fixture input'.padStart(40)}`);
    failed += 1;
    continue;
  }

  try {
    const t0 = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, `${base}.wasm`, `${base}.zkey`,
    );
    const proveMs = performance.now() - t0;

    const vkey = JSON.parse(readFileSync(`${base}_vkey.json`, 'utf8'));
    const t1 = performance.now();
    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    const verifyMs = performance.now() - t1;

    if (!ok) failed += 1;
    measured[name] = { proveMs, verifyMs, ok };

    const drift = ((proveMs / handoffMs - 1) * 100);
    console.log(
      name.padEnd(16)
      + fmt(proveMs).padStart(10)
      + fmt(verifyMs).padStart(10)
      + `${handoffMs}ms`.padStart(10)
      + `${drift >= 0 ? '+' : ''}${drift.toFixed(0)}%`.padStart(10)
      + `  ${ok ? 'ok' : 'PROOF REJECTED'}`,
    );
  } catch (e) {
    console.log(`${name.padEnd(16)}  ERROR: ${e.message}`);
    failed += 1;
  }
}

console.log('='.repeat(64));

// The harness reads this and uses it as the multiplier's denominator, so the browser is
// always compared against Node ON THE SAME MACHINE. Gitignored -- it describes this laptop,
// not the project.
writeFileSync(
  join(PUBLIC, 'fixtures', 'node-baseline.json'),
  `${JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, circuits: measured }, null, 2)}\n`,
);

if (failed) {
  console.error(
    `\n${failed} circuit(s) failed. If proofs are being rejected, the zkey and vkey in\n`
    + "public/ are from different builds -- re-run 'npm run sync' after 'make circuits'.\n",
  );
  process.exit(1);
}
console.log(
  '\nAll proofs verified. Wrote public/fixtures/node-baseline.json — the harness uses it\n'
  + 'as the multiplier baseline, so browser and Node are compared on the same machine.\n',
);

// snarkjs leaves ffjavascript's worker pool running and it holds the event loop open
// forever. atrum-core's own scripts end the same way (prove.mjs:139,
// gen_action_fixtures.mjs:799) for exactly this reason.
process.exit(0);
