/**
 * Circuit artefact cache, in IndexedDB.
 *
 * A full client is 29.7MB of wasm and proving keys, and `bet_encrypted` alone is 11.8MB --
 * which a user must download before their first bet. Re-fetching that per session is not
 * viable at any proving speed, so this was never gated on the browser measurement.
 *
 * LAZY, PER ACTION. Nothing is fetched until an action needs it. Depositing pulls 2.4MB;
 * only betting pulls the big one. Fetching all four up front would put 29.7MB in front of a
 * user who has not decided to do anything yet.
 *
 * KEYED BY CONTENT, NOT BY NAME. The cache key includes a fingerprint of the circuit's
 * verification key, so rebuilt circuits miss the cache instead of silently proving against a
 * stale zkey. That failure mode is worth designing against: a stale proving key produces a
 * perfectly well-formed proof that the on-chain verifier rejects, with no diagnostic --
 * indistinguishable from a broken contract. atrum-core hit exactly this when it committed
 * verification keys and a clean `git pull` failed a third of the Solidity suite.
 */

const DB_NAME = "atrum-artifacts";
const DB_VERSION = 1;
const STORE = "circuits";

/** Bytes needed per action, for showing an honest prompt before a long download. */
export const ACTION_ARTIFACTS = {
  deposit: ["deposit"],
  bet: ["bet_encrypted"],
  redeem: ["redeem_private"],
  withdraw: ["withdraw"],
};

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(store, mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      }),
  );
}

const get = (key) => idb(STORE, "readonly", (s) => s.get(key));
const put = (key, value) => idb(STORE, "readwrite", (s) => s.put(value, key));

/**
 * A short content fingerprint of the verification key.
 *
 * The vkey is small (a few KB) and changes whenever the circuit or the trusted setup
 * changes, which is exactly when cached proving artefacts must be discarded. Fetching it to
 * decide whether the 11.8MB below is still valid is a good trade.
 */
async function vkeyFingerprint(baseUrl) {
  const res = await fetch(`${baseUrl}_vkey.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`no vkey for ${baseUrl} (${res.status})`);
  const buf = await res.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Fetch with progress, so a caller can show something honest during an 11.8MB download
 * rather than a spinner that looks identical to a hang.
 */
async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);

  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * The wasm and zkey for one circuit, from cache when possible.
 *
 * @param name       circuit name, e.g. "bet_encrypted"
 * @param baseUrl    where artefacts are served from
 * @param onProgress (loaded, total, what) -- called only on a real download
 */
export async function loadCircuit(name, baseUrl = "./public/circuits", onProgress) {
  const base = `${baseUrl}/${name}/${name}`;
  const fingerprint = await vkeyFingerprint(base);
  const key = `${name}:${fingerprint}`;

  const cached = await get(key).catch(() => null);
  if (cached) return { ...cached, cached: true, fingerprint };

  const wasm = await fetchWithProgress(`${base}.wasm`, (l, t) =>
    onProgress?.(l, t, `${name}.wasm`),
  );
  const zkey = await fetchWithProgress(`${base}.zkey`, (l, t) =>
    onProgress?.(l, t, `${name}.zkey`),
  );

  const entry = { wasm, zkey };
  // A failed write is not fatal -- private browsing and storage pressure both cause it, and
  // the client still works, just slower next time.
  await put(key, entry).catch(() => {});

  return { ...entry, cached: false, fingerprint };
}

/** Total bytes already cached, for showing what a device has committed to storage. */
export async function cachedCircuits() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAllKeys();
    req.onsuccess = () => {
      db.close();
      resolve(req.result.map(String));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearCache() {
  await idb(STORE, "readwrite", (s) => s.clear());
}
