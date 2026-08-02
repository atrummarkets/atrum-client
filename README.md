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

## Measured, in headless Chromium 151

`npm run browser-baseline`. Every proof verified in-browser.

| circuit | download | Node | browser | multiplier | frame stall |
|---|---|---|---|---|---|
| `deposit` | 2.4MB | 369 ms | **276 ms** | **0.75×** | 96 ms |
| `bet_encrypted` | 11.8MB | 881 ms | 1.83 s | 2.08× | **388 ms** |
| `redeem_private` | 7.8MB | 517 ms | 1.04 s | 2.01× | 117 ms |
| `withdraw` | 7.8MB | 517 ms | 1.27 s | 2.46× | 134 ms |

`deposit` proving *faster* in a browser than in Node is not an error — at 1,621 constraints,
Node's process and module-load overhead outweighs the proving itself, while the browser
arrives warm. The multiplier is not a constant to extrapolate with.

### Why proving runs in a Web Worker

Not the multiplier — the **stall**. `requestAnimationFrame` stops firing while the main
thread is blocked, so the gap after it resumes is the freeze a user actually sees. A 2×
multiplier would have been survivable; a third of a second of dead UI on the primary action
is not.

`npm run worker-check` proves the fix works rather than assuming it, by proving
`bet_encrypted` both ways in one page:

| mode | prove | frame stall | UI |
|---|---|---|---|
| main thread | 1.00 s | 136 ms | frozen |
| **web worker** | 1.02 s | **27 ms** | responsive |

**The worker costs nothing in proving time and removes the freeze.** (On a worker's very
first use the figure is ~2× higher — a cold wasm compile inside the worker, not a steady-state
cost. It disappears on any subsequent proof.)

## Status

- [x] Harness: 4 circuits, timed and verified against a same-machine Node baseline
- [x] Browser numbers measured and recorded in atrum-core `HANDOFF.md`
- [x] Web Worker decision made on evidence, and verified by A/B
- [x] IndexedDB artefact cache, keyed by verification-key fingerprint
- [x] Sequencer CORS (in atrum-core, with tests on every branch)
- [x] Witness building from **real notes** rather than the canned fixtures
- [x] Wallet connection and transaction submission (`app.html`)
- [x] `betEncrypted`, `redeemPrivate`, `withdraw` all wired — the notes table itself is the
      action launcher: what a note can do next comes from its own state (`noteRole`)
- [x] **The full lifecycle, verified live** — deposit, bet, resolve, settle, redeem, withdraw,
      six real transactions on Monad testnet, every one built by this exact client code
      (`scripts/live-loop.mjs` drove `app.html` headlessly with a real funded wallet, not a
      mock of the client). Block numbers and tx hashes in atrum-core `HANDOFF.md` "0-ter".

### The deployment moves whenever the circuits do

`SHIELDED_POOL` currently points at `0xa54cc8AC537E64f70e1b842A9edc4169ed22D06f`. Two earlier
pools are referenced in older commits/conversation and should not be used: `0x5Ede6585...`
(still valid, normal 7-day betting window — just not what this constant points at) and
`0x6af21cA1...` (actually dead — its verifiers were baked against a zkey circuits/build/ no
longer holds, so every proof fails `InvalidProof()` there). Full account of both in
atrum-core's `deployments/monad-testnet-10143/README.md` and `HANDOFF.md`.

**Running your own sequencer against this pool?** Two things that will otherwise cost an
hour: the sequencer's default port (`:8080`) collides with this app's own dev server — run it
with `PORT=8081` (matches `src/sequencer.mjs`'s default). And `ShieldedPool.onlySequencer`
authorizes exactly one fixed address, set at deploy time (`SEQUENCER` env var) — it does not
automatically accept whichever relayer your `RELAYER_MNEMONIC` happens to rotate to next. If
`flushBatch` reverts with `NotSequencer()`, that mismatch is why.

## Using the client

**By hand**, with a real wallet extension:

```bash
npm run harness   # serves everything; open http://localhost:8080/app.html
```

Connect a wallet on Monad testnet (chain 10143). The page reads the vault, collateral token
and denomination **from the chain**, starting at the pool address — nothing about the
deployment is hardcoded here except `ShieldedPool`, because addresses copied into a frontend
go stale silently, which is how this project already shipped a market that could never settle.
Every note gets an action button in the "Your notes" table driven by its own state — deposit
an unbet note to get a "Bet" button, a position note gets "Redeem" once the market is resolved
and settled, a settled note gets "Withdraw".

**Scripted**, with a real wallet but no browser interaction:

```bash
PRIVATE_KEY=0x... node scripts/live-loop.mjs deposit
PRIVATE_KEY=0x... node scripts/live-loop.mjs bet YES     # or NO
PRIVATE_KEY=0x... node scripts/live-loop.mjs redeem
PRIVATE_KEY=0x... node scripts/live-loop.mjs withdraw <amount>
```

Drives the real `app.html` headlessly with a real funded `ethers.Wallet` standing in for
MetaMask — `window.ethereum.request` signs and broadcasts through it directly, every read
forwards to testnet RPC. This is not a simulation of the client; it is the client, with a
scriptable wallet. Persists a real browser profile (`.live-loop-profile/`, gitignored) across
invocations, same as a human's notes would persist across tabs.

You need, on the connected/private-key account:

- **MON** for gas. Every shielded action declares the same 2,500,000 limit, and Monad bills
  the *declared* limit rather than the gas used — measured, not assumed. That uniformity is an
  anti-fingerprinting rule, so the client does not let the wallet estimate per action.
- **Collateral**, which is a `MockERC20` on this deployment and has to be minted to you.
- A **sequencer running against this pool** for anything past deposit — see the port and
  `SEQUENCER`-address notes above. Nothing here starts one for you.

> **This deployment is not private.** The committee key it encrypts against is a test key with
> a published secret, so anyone can decrypt every bet. That holds until the trusted-setup
> ceremony runs. Do not deposit anything you would mind losing.

### The seam check

`npm run fresh-note`. Every proof this project had produced — here and in atrum-core — used
inputs the repo generated for itself. A client-built witness against a repo-built circuit is
exactly the kind of seam where all three of this project's real bugs have lived.

So this generates a note in the browser from fresh randomness, builds the witness with the
client's own code, proves it, and checks it against `deposit_vkey.json`:

```
  verifies against vkey yes
  signals match note    yes
  Solidity calldata     yes
```

If the client's commitment derivation disagreed with `note.circom` by one bit, the witness
would not satisfy the constraints and this would fail. It needs no chain, no sequencer and no
funded key, so it can run in CI.

**What is still untested is only the on-chain submission**, which needs a funded testnet key.

