# atrum-client

Browser proving harness — and, later, the real client — for the Atrum shielded pool.

The protocol is done and proven on Monad testnet. The frontend is the critical path, and the
one number that decides its architecture was never measured: **how long Groth16 proving takes
in a browser.** A user cannot place a first bet without downloading 11.8MB of
`bet_encrypted` artefacts and proving in their tab. Nothing about the client — Web Worker or
not, what to cache, what to lazy-load — can be settled before that number exists.

So this repo starts as a harness, not a UI.

## Setup

```bash
cd ../atrum-core && make bench    # measure Node proving on THIS machine
cd ../atrum-client
npm install
npm run sync       # copy artefacts + bundle core's primitives for the browser
npm run harness    # serve on :8080, then open http://localhost:8080/harness.html
```

`npm run sync` reads from `../atrum-core` by default; override with
`ATRUM_CORE=/path/to/atrum-core npm run sync`. It needs atrum-core to have been built at
least once (`make circuits`), because every artefact it copies is gitignored there and
regenerated per build.

## What lives where

This repo is the **frontend**. Anything that measures or defines the protocol lives in
`atrum-core`:

| concern | repo |
|---|---|
| circuits, contracts, sequencer, ceremony | `atrum-core` |
| Node proving benchmarks (`make bench`) | `atrum-core` |
| note/commitment, packing, ElGamal | `atrum-core` |
| browser harness, client, worker, IndexedDB | here |

`npm run sync` bundles core's `atrum.mjs` and `lib/elgamal.mjs` into
`public/vendor/atrum-core.mjs` with esbuild, rather than this repo reimplementing them.
Those hashing rules already exist three times — in `note.circom`, in
`IncrementalMerkleTree.sol` and in `atrum.mjs` — and all three must agree bit for bit. A
fourth copy in the frontend is how they would drift, and a divergent commitment fails at
proof verification with no diagnostic.

Every sync therefore ends by running `scripts/verify-bundle.mjs`, which re-derives values
the circuits already accepted (the recorded public signals in `witness-inputs.json`) and
**refuses the bundle if any differ**. That is what makes trusting the browser shims for
`buffer`/`events`/`assert` defensible.

## Why the baseline step matters

Run `make bench` in atrum-core before the harness. It measures Node proving there and writes
`circuits/build/proving-baseline.json`, which `npm run sync` copies here and the harness uses
as the multiplier's denominator.

Without it the harness falls back to the Node timings in atrum-core's `HANDOFF.md` — which
were recorded on a different machine. Measured here, the same four circuits prove roughly
twice as fast as that record:

| circuit | HANDOFF | this machine |
|---|---|---|
| `deposit` | 322 ms | ~369 ms |
| `bet_encrypted` | 2,255 ms | ~881 ms |
| `redeem_private` | 1,437 ms | ~517 ms |
| `withdraw` | 1,411 ms | ~517 ms |

Dividing a browser time measured here by a Node time measured there describes the two
machines as much as the two runtimes, and would understate the browser multiplier by about
2×. Same machine, same day, or the ratio means nothing.

## What the harness measures

Per circuit: download size and fetch time, prove time, **verify result**, and a rough heap
delta (`performance.memory`, Chrome-only and non-standard — a proxy, not a measurement).

It always verifies. A proof that is fast and wrong is worse than one that is slow and right,
and a mismatched zkey/vkey pair produces exactly that.

Inputs are the canned fixtures atrum-core recorded during its proving spike
(`circuits/build/witness-inputs.json`), so what is measured is proving cost, not witness
construction. Building witnesses from real user notes comes with the client and is a separate,
much smaller cost.

## Nothing here is committed except source

`public/` is entirely gitignored. Every artefact in it is gitignored in atrum-core too, for a
load-bearing reason: `snarkjs zkey contribute` is deliberately non-deterministic, so a zkey
committed here would only ever match the machine that built it. atrum-core learned this by
committing verification keys — a clean `git pull` then failed a third of its Solidity suite
with `InvalidProof()`, which looks exactly like broken contracts.

Re-run `npm run sync` after every `make circuits` in atrum-core.

## Status

- [x] Harness: 4 circuits, timed and verified, local Node baseline
- [ ] Browser numbers recorded back into atrum-core `HANDOFF.md`
- [ ] Web Worker decision (gated on those numbers)
- [ ] Client: IndexedDB artefact cache, lazy-load per action, witness building from real
      notes, Merkle paths from the sequencer's `GET /path?commitment=…`, denomination
      snapping

The sequencer sets no CORS headers today, so the client will need
`Access-Control-Allow-Origin` added in atrum-core's `sequencer/src/main.ts` before it can
fetch Merkle paths cross-origin. The harness does not need this — it runs entirely off local
fixtures.
