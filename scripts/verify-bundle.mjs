/**
 * Assert the browser bundle agrees with the circuits, bit for bit.
 *
 * WHY THIS RUNS ON EVERY SYNC. `atrum.mjs` is the third implementation of Atrum's hashing
 * rules, next to `note.circom` and `IncrementalMerkleTree.sol`, and bundling it for the
 * browser adds a fourth surface where they could diverge -- esbuild resolves `circomlibjs`
 * through browser shims for `buffer`, `events` and `assert`, and a shim that subtly
 * misbehaves would produce plausible-looking wrong hashes.
 *
 * A divergent commitment does not fail loudly. It fails at proof verification, with no
 * diagnostic, looking exactly like a broken contract. So rather than trusting the bundle,
 * this recomputes values the CIRCUITS already accepted -- the recorded public signals in
 * witness-inputs.json -- and asserts the bundle reproduces them.
 *
 * That also covers the two packers written for the client (packRedeemMeta,
 * packWithdrawData), checking them against real circuit output rather than against the
 * formula they were copied from.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// This is a BROWSER bundle, so ffjavascript's thread pool references `Worker` at module
// scope. Hashing never touches it -- the pool exists for parallel proving -- so a stub is
// enough to import the module under Node. If anything actually calls it, it throws rather
// than silently returning something wrong.
globalThis.Worker ??= class {
  constructor() {
    throw new Error("Worker is stubbed: this bundle is meant for a browser");
  }
};

// Hide Node's `Buffer` global so this check fails the way a browser would.
//
// Learned the hard way: circomlibjs's dependencies reference `Buffer` as a free global, not
// only as a bare import, so aliasing the `buffer` package is not enough. With Node's Buffer
// in scope this script happily verified a bundle that died on load in a real browser with
// "Buffer is not defined". A check that only passes because of the environment it runs in is
// worse than no check -- it certifies the bug.
const nodeBuffer = globalThis.Buffer;
const nodeProcess = globalThis.process;
delete globalThis.Buffer;
delete globalThis.process;

const atrum = await import(join(ROOT, "public", "vendor", "atrum-core.mjs"));

// Restore them: reading the fixture file below goes through Node's fs, and process.exit is
// how this script reports its verdict.
globalThis.Buffer = nodeBuffer;
globalThis.process = nodeProcess;
const inputs = JSON.parse(
  readFileSync(join(ROOT, "public", "fixtures", "witness-inputs.json"), "utf8"),
);

await atrum.init();

const B = (v) => BigInt(v);
const checks = [];
const check = (name, got, want) =>
  checks.push({ name, ok: B(got) === B(want), got: String(got), want: String(want) });

// deposit pins outcome = 0 (unbet collateral).
{
  const d = inputs.deposit;
  check(
    "deposit commitment",
    atrum.noteCommitment({
      nullifier: B(d.nullifier),
      secret: B(d.secret),
      marketId: B(d.marketId),
      outcome: 0n,
      units: B(d.units),
    }),
    d.commitment,
  );
}

// bet_encrypted spends an unbet note and emits a positioned one.
{
  const b = inputs.bet_encrypted;
  check("bet_encrypted nullifierHash", atrum.nullifierHash(B(b.nullifier)), b.nullifierHash);
  check("bet_encrypted betMeta", atrum.packMarketMeta(B(b.marketId), B(b.outcome)), b.betMeta);
  check(
    "bet_encrypted newCommitment",
    atrum.noteCommitment({
      nullifier: B(b.newNullifier),
      secret: B(b.newSecret),
      marketId: B(b.marketId),
      outcome: B(b.outcome),
      units: B(b.units),
    }),
    b.newCommitment,
  );
}

// redeem_private always emits outcome 3 (SETTLED). Exercises packRedeemMeta.
{
  const r = inputs.redeem_private;
  check(
    "redeem_private redeemMeta",
    atrum.packRedeemMeta(B(r.marketId), B(r.outcome), B(r.totalPool), B(r.winningPool)),
    r.redeemMeta,
  );
}

// withdraw pins both notes to 3. Exercises packWithdrawData.
{
  const w = inputs.withdraw;
  check(
    "withdraw withdrawData",
    atrum.packWithdrawData(B(w.marketId), B(w.recipient), B(w.amount)),
    w.withdrawData,
  );
}

const failed = checks.filter((c) => !c.ok);

for (const c of checks) {
  console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}`);
  if (!c.ok) {
    console.log(`          got  ${c.got}`);
    console.log(`          want ${c.want}`);
  }
}

if (failed.length) {
  console.error(
    `\n${failed.length} of ${checks.length} checks FAILED. The browser bundle does not agree\n` +
      "with the circuits. Do not ship it -- proofs built with it will be rejected on chain\n" +
      "with no useful error.\n",
  );
  process.exit(1);
}

console.log(`\n  ${checks.length} checks passed — bundle agrees with the circuits.\n`);
process.exit(0);
