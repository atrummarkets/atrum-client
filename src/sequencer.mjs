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
