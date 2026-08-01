/**
 * Note lifecycle: create them, keep them, turn them into circuit inputs.
 *
 * A NOTE IS THE FUNDS. `nullifier` and `secret` are the only things that prove ownership of
 * a shielded position -- there is no account, no recovery, and nothing on chain that can be
 * queried to reconstruct them. Lose them and the collateral is unspendable forever. That is
 * why they are persisted before the transaction is sent, not after: a deposit that lands on
 * chain while its note only ever existed in a variable is money burned.
 *
 * The hashing itself is NOT here. It comes from atrum-core via the bundled
 * `public/vendor/atrum-core.mjs`, because those rules already exist three times
 * (`note.circom`, `IncrementalMerkleTree.sol`, `atrum.mjs`) and must agree bit for bit. This
 * module only composes them.
 */

import * as core from "../public/vendor/atrum-core.mjs";

export const OUTCOME = { UNBET: 0n, YES: 1n, NO: 2n, SETTLED: 3n };

const DB_NAME = "atrum-notes";
const STORE = "notes";

/**
 * A uniform field element, rejection sampled.
 *
 * Rejection rather than `mod FIELD_SIZE`: reducing a 256-bit value into a slightly smaller
 * field biases the low range, and for a nullifier that shrinks the effective search space an
 * attacker faces. The loop rejects roughly one sample in 2^-6 of cases, so it terminates
 * immediately in practice.
 */
export function randomFieldElement() {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const value = BigInt(`0x${hex}`);
    if (value > 0n && value < core.FIELD_SIZE) return value;
  }
}

/**
 * A fresh unbet note. This is what a deposit creates.
 *
 * `outcome` is pinned to UNBET because `deposit.circom` pins it too -- the circuit will not
 * accept anything else, and letting a caller pass a value that can only be 0 invites a
 * mismatch that surfaces as an unexplained proof failure.
 */
export async function createNote({ marketId, units }) {
  await core.init();

  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const note = {
    nullifier,
    secret,
    marketId: BigInt(marketId),
    outcome: OUTCOME.UNBET,
    units: BigInt(units),
  };

  return { ...note, commitment: core.noteCommitment(note) };
}

/** The note a bet produces: same owner-chosen randomness scheme, new secrets, a side. */
export async function createPositionNote({ marketId, units, outcome }) {
  await core.init();

  const nullifier = randomFieldElement();
  const secret = randomFieldElement();
  const note = {
    nullifier,
    secret,
    marketId: BigInt(marketId),
    outcome: BigInt(outcome),
    units: BigInt(units),
  };

  return { ...note, commitment: core.noteCommitment(note) };
}

/**
 * Circuit input for `deposit`.
 *
 * Public signals are [commitment, marketId, units] -- no Merkle path, because a deposit
 * creates a leaf rather than spending one. This is the only action a brand-new user can take
 * and the only one that needs nothing from the sequencer.
 */
export function depositInput(note) {
  if (!core.isValidDenomination(note.units)) {
    throw new Error(
      `${note.units} is not a valid denomination. ` +
        `The chain accepts powers of ten only: ${core.DENOMINATIONS.join(", ")}.`,
    );
  }

  return {
    commitment: note.commitment.toString(),
    marketId: note.marketId.toString(),
    units: note.units.toString(),
    nullifier: note.nullifier.toString(),
    secret: note.secret.toString(),
  };
}

/**
 * Circuit input for `bet_encrypted`: spend an unbet note, emit a positioned one, and publish
 * an ElGamal ciphertext of the stake.
 *
 * @param spend    the unbet note being consumed
 * @param position the new note, from createPositionNote
 * @param path     from the sequencer: { root, pathElements, pathIndices }
 * @param elgamal  an instance built against the committee key
 */
export async function betInput({ spend, position, path, elgamal }) {
  if (spend.outcome !== OUTCOME.UNBET) throw new Error("only an unbet note can be staked");
  if (position.units !== spend.units) throw new Error("a bet stakes the whole note");
  if (position.outcome !== OUTCOME.YES && position.outcome !== OUTCOME.NO) {
    throw new Error("a position must be YES or NO");
  }

  // The randomness is drawn here, not inside encrypt(), because it is a secret the client
  // owns and must also hand to the circuit as `encRandomness`.
  const randomness = elgamal.randomScalar();

  // encRandomness = 0 makes C1 the identity and C2 = [units]G, so anyone recovers the stake
  // by discrete log. The circuit and the contract both reject it, but a client that produced
  // it would publish every bet while everything downstream looked healthy -- so refuse here
  // too, where the value is actually chosen. randomScalar samples from [1, l), so this is a
  // belt-and-braces check on an invariant that is already meant to hold.
  if (randomness === 0n) throw new Error("degenerate encryption randomness");

  const { c1: c1Point, c2: c2Point } = elgamal.encrypt(spend.units, randomness);
  const c1 = elgamal.asPair(c1Point);
  const c2 = elgamal.asPair(c2Point);

  return {
    root: path.root.toString(),
    nullifierHash: core.nullifierHash(spend.nullifier).toString(),
    newCommitment: position.commitment.toString(),
    betMeta: core.packMarketMeta(position.marketId, position.outcome).toString(),
    c1: c1.map(String),
    c2: c2.map(String),
    nullifier: spend.nullifier.toString(),
    secret: spend.secret.toString(),
    newNullifier: position.nullifier.toString(),
    newSecret: position.secret.toString(),
    marketId: position.marketId.toString(),
    outcome: position.outcome.toString(),
    units: position.units.toString(),
    encRandomness: randomness.toString(),
    pathElements: path.pathElements.map(String),
    pathIndices: path.pathIndices.map(String),
  };
}

// ---------------------------------------------------------------- persistence

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const serialise = (n) =>
  Object.fromEntries(Object.entries(n).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));

const deserialise = (n) => ({
  ...n,
  nullifier: BigInt(n.nullifier),
  secret: BigInt(n.secret),
  marketId: BigInt(n.marketId),
  outcome: BigInt(n.outcome),
  units: BigInt(n.units),
  commitment: BigInt(n.commitment),
});

/** Persist a note. Call this BEFORE broadcasting the transaction that commits to it. */
export async function saveNote(note, meta = {}) {
  const db = await openDb();
  const record = { id: note.commitment.toString(), ...serialise(note), ...meta, savedAt: Date.now() };
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return record;
}

export async function allNotes() {
  const db = await openDb();
  const records = await new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return records.map(deserialise);
}

/**
 * Everything needed to restore this wallet elsewhere, as JSON.
 *
 * Offered because IndexedDB is not durable in the way users assume -- "clear browsing data"
 * erases it, and with it the only proof of ownership of every position.
 */
export async function exportNotes() {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), notes: (await allNotes()).map(serialise) },
    null,
    2,
  );
}
