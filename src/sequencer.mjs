/**
 * Merkle paths, from the sequencer.
 *
 * The contract keeps only a frontier and a root -- it deliberately cannot produce a path,
 * which is the whole reason the sequencer exists. A client asks for the path to its
 * commitment and builds the proof locally; the sequencer never sees a secret and cannot
 * produce a proof itself.
 */

// NOT :8080 -- that's where `npm run harness` serves this app itself
// (`http-server . -p 8080`). Running both on the same port silently serves one or the other
// depending on start order, which is a confusing way to lose an afternoon. The sequencer
// must be started with PORT=8081 to match.
const DEFAULT_URL = "http://localhost:8081";

export class NotYetGrafted extends Error {
  constructor(commitment) {
    super(
      `commitment ${commitment} is not in the tree yet — the sequencer batches deposits, ` +
        "so this is normal for up to a minute after depositing",
    );
    this.name = "NotYetGrafted";
  }
}

/**
 * The path for `commitment`.
 *
 * A 400 here is NOT a failure: the sequencer batches commitments before grafting them, so a
 * freshly deposited note is legitimately absent for a while. Treating that as an error is how
 * a client ends up showing a scary message for the normal case.
 */
export async function pathFor(commitment, { baseUrl = DEFAULT_URL } = {}) {
  const res = await fetch(`${baseUrl}/path?commitment=${commitment.toString()}`);

  if (res.status === 400) throw new NotYetGrafted(commitment);
  if (!res.ok) throw new Error(`sequencer returned ${res.status} ${res.statusText}`);

  const body = await res.json();
  return {
    index: body.index,
    root: BigInt(body.root),
    pathElements: body.pathElements.map(BigInt),
    pathIndices: body.pathIndices.map(BigInt),
  };
}

/** Poll until a commitment is grafted, for the wait right after a deposit. */
export async function waitForGraft(
  commitment,
  { baseUrl = DEFAULT_URL, timeoutMs = 180000, intervalMs = 5000, onWait } = {},
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await pathFor(commitment, { baseUrl });
    } catch (e) {
      if (!(e instanceof NotYetGrafted)) throw e;
      if (Date.now() > deadline) {
        throw new Error(`commitment was still not grafted after ${timeoutMs / 1000}s`);
      }
      onWait?.(Math.round((deadline - Date.now()) / 1000));
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

export async function health({ baseUrl = DEFAULT_URL } = {}) {
  const res = await fetch(`${baseUrl}/health`);
  if (!res.ok) throw new Error(`sequencer unhealthy: ${res.status}`);
  return res.json();
}

/**
 * Submit an action through the relayer, so this wallet's address never touches the chain.
 *
 * WHY THIS EXISTS AT ALL. Every proof in this client carefully hides which note was spent and
 * how much was staked -- and then, submitted directly, the transaction's `from` field names
 * the user anyway. Combined with `betMeta`, which carries the outcome in the clear, the chain
 * reads "0xYou bet YES". Relaying is what makes the rest of the cryptography mean anything.
 *
 * Only the three proof-gated actions are accepted. `deposit` is not relayable: it pulls
 * collateral via `transferFrom(msg.sender)`, so a relayer submitting it would have to hold
 * the money first -- the same link, one hop along.
 *
 * WHAT THIS DOES NOT DO: the relayer sees your network address and your proof. Trust is moved,
 * not removed. It can also refuse to submit, which is a second censorship point after the
 * sequencer. Neither is fixed here.
 *
 * @param calldata snarkjs `exportSolidityCallData` output -- NOT the raw proof (the G2 swap)
 * @param tail     the action's arguments after pA/pB/pC, already ordered
 */
export async function relay(action, { calldata, tail, baseUrl = DEFAULT_URL }) {
  const flat = JSON.parse(`[${calldata}]`);
  const [pA, pB, pC] = flat;

  const res = await fetch(`${baseUrl}/relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      pA: pA.map(String),
      pB: pB.map((row) => row.map(String)),
      pC: pC.map(String),
      args: tail,
    }),
  });

  const body = await res.json().catch(() => ({ error: `relayer returned ${res.status}` }));
  if (!res.ok) throw new Error(body.error ?? `relayer returned ${res.status}`);
  return body;
}
