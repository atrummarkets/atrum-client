// Atrum browser proving harness.
//
// One question, answered with a real number: what does Groth16 proving cost in a browser?
//
// atrum-core measured proving under Node (HANDOFF.md, "Proving spike"), but Node timings are
// a LOWER BOUND -- they run on a JIT that has been warm for the whole process, with no tab,
// no compositor and no memory ceiling. The browser multiplier decides the entire UX, because
// a user cannot place a first bet without downloading 11.8MB of `bet_encrypted` artefacts and
// proving in this tab. Nothing about the client architecture (worker or no worker, what to
// cache, what to lazy-load) can be decided before this number exists.
//
// Inputs are the canned fixtures atrum-core recorded during its proving spike, so what is
// measured here is proving cost, not witness construction. Witness construction from real
// user notes comes with the client, and is a separate (much smaller) cost.

const CIRCUITS = [
  // Fallback baselines from atrum-core HANDOFF.md, "Proving spike -- before building a
  // frontend". These are only used if `npm run baseline` has not been run.
  //
  // THEY ARE THE WRONG DENOMINATOR ON ANY OTHER MACHINE. Measured here, the same four
  // circuits prove in 402ms / 1.00s / 558ms / 592ms -- roughly twice as fast as the machine
  // that recorded HANDOFF. Dividing a browser time measured on this laptop by a Node time
  // measured on that one describes the two laptops as much as the two runtimes, and would
  // understate the browser multiplier by about 2x.
  { name: 'deposit', handoffMs: 322, constraints: 1621 },
  { name: 'bet_encrypted', handoffMs: 2255, constraints: 21252 },
  { name: 'redeem_private', handoffMs: 1437, constraints: 14405 },
  { name: 'withdraw', handoffMs: 1411, constraints: 14438 },
];

// Filled from public/fixtures/node-baseline.json when present.
let baselineSource = 'HANDOFF.md (different machine — run `npm run baseline` for a real multiplier)';

const $ = (id) => document.getElementById(id);
const rows = $('rows');
const logEl = $('log');

function log(msg) {
  logEl.textContent += `\n${msg}`;
  logEl.scrollTop = logEl.scrollHeight;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);

// performance.memory is Chrome-only and non-standard, and it reports the whole JS heap
// rather than this circuit's share. It is a proxy, not a measurement -- labelled as such in
// the UI so nobody quotes it as one.
const heapUsed = () => (performance.memory ? performance.memory.usedJSHeapSize : null);

async function fetchBinary(url) {
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  return { data: buf, bytes: buf.byteLength, ms: performance.now() - t0 };
}

function cell(row, text, cls) {
  const td = document.createElement('td');
  td.textContent = text;
  if (cls) td.className = cls;
  row.appendChild(td);
  return td;
}

function addRow(name) {
  const tr = document.createElement('tr');
  const first = document.createElement('td');
  first.innerHTML = `<code>${name}</code>`;
  tr.appendChild(first);
  for (let i = 0; i < 7; i += 1) cell(tr, '·', 'dim');
  rows.appendChild(tr);
  return tr;
}

function setRow(tr, values) {
  const tds = tr.querySelectorAll('td');
  values.forEach((v, i) => {
    const td = tds[i + 1];
    if (v === undefined) return;
    td.textContent = v.text;
    td.className = v.cls || '';
  });
}

async function runCircuit(spec, inputs, tr) {
  const { name, nodeMs } = spec;
  const base = `./public/circuits/${name}/${name}`;


  const input = inputs[name];
  if (!input) throw new Error(`no fixture input for ${name} in witness-inputs.json`);

  log(`\n[${name}] fetching artefacts…`);
  const [wasm, zkey] = await Promise.all([
    fetchBinary(`${base}.wasm`),
    fetchBinary(`${base}.zkey`),
  ]);
  const bytes = wasm.bytes + zkey.bytes;
  const fetchMs = Math.max(wasm.ms, zkey.ms); // fetched in parallel, so wall clock is the max
  log(`[${name}] ${fmtBytes(bytes)} in ${fmtMs(fetchMs)} `
    + `(wasm ${fmtBytes(wasm.bytes)}, zkey ${fmtBytes(zkey.bytes)})`);
  setRow(tr, [{ text: fmtBytes(bytes) }, { text: fmtMs(fetchMs) }, { text: `${nodeMs} ms`, cls: 'dim' }]);

  // Yield so the row above paints before the main thread is monopolised by proving. That
  // stall is itself a finding: if the UI cannot repaint during fullProve, the client needs a
  // Web Worker regardless of how the raw multiplier comes out.
  await new Promise((r) => setTimeout(r, 0));

  const heapBefore = heapUsed();
  log(`[${name}] proving…`);
  const t0 = performance.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm.data, zkey.data);
  const proveMs = performance.now() - t0;
  const heapAfter = heapUsed();

  const multiplier = proveMs / nodeMs;
  log(`[${name}] proved in ${fmtMs(proveMs)} — ${multiplier.toFixed(2)}× the Node baseline`);

  // Verify, always. A proof that is fast and wrong is worse than one that is slow and right,
  // and passing the wrong zkey/wasm pair produces exactly that.
  let verifyText = 'no vkey';
  let verifyCls = 'warn';
  try {
    const vkey = await (await fetch(`${base}_vkey.json`)).json();
    const t1 = performance.now();
    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
    const verifyMs = performance.now() - t1;
    verifyText = ok ? `ok · ${fmtMs(verifyMs)}` : 'FAILED';
    verifyCls = ok ? 'ok' : 'bad';
    log(`[${name}] verify: ${ok ? 'ok' : 'FAILED'} in ${fmtMs(verifyMs)}`);
    if (!ok) log(`[${name}] the zkey and vkey do not match — re-run 'npm run sync'`);
  } catch (e) {
    log(`[${name}] verify skipped: ${e.message}`);
  }

  const heapText = heapBefore !== null && heapAfter !== null
    ? fmtBytes(Math.max(0, heapAfter - heapBefore))
    : 'n/a';

  setRow(tr, [
    { text: fmtBytes(bytes) },
    { text: fmtMs(fetchMs) },
    { text: `${nodeMs} ms`, cls: 'dim' },
    { text: fmtMs(proveMs) },
    { text: `${multiplier.toFixed(2)}×`, cls: `mult ${multiplier > 3 ? 'bad' : multiplier > 1.75 ? 'warn' : 'ok'}` },
    { text: verifyText, cls: verifyCls },
    { text: heapText, cls: 'dim' },
  ]);

  return { name, bytes, fetchMs, proveMs, nodeMs, multiplier };
}

$('runAll').onclick = async () => {
  $('runAll').disabled = true;
  rows.innerHTML = '';
  logEl.textContent = 'loading fixture inputs…';

  $('memnote').textContent = performance.memory
    ? 'Heap Δ is performance.memory, which is Chrome-only, non-standard, and measures the whole JS heap rather than this circuit’s share. Treat it as a proxy, not a measurement.'
    : 'Heap Δ unavailable — performance.memory is Chrome-only. Run in Chrome for a rough memory proxy.';

  try {
    const inputs = await (await fetch('./public/fixtures/witness-inputs.json')).json();

    // Prefer a baseline measured on THIS machine over HANDOFF's, so the multiplier compares
    // two runtimes rather than two laptops.
    try {
      const res = await fetch('./public/fixtures/node-baseline.json');
      if (res.ok) {
        const baseline = await res.json();
        let matched = 0;
        for (const spec of CIRCUITS) {
          const m = baseline.circuits?.[spec.name];
          if (m?.proveMs) { spec.nodeMs = m.proveMs; matched += 1; }
        }
        if (matched) {
          baselineSource = `this machine, ${new Date(baseline.measuredAt).toLocaleString()} `
            + `(Node ${baseline.node})`;
        }
      }
    } catch { /* fall through to the HANDOFF constants */ }

    for (const spec of CIRCUITS) if (!spec.nodeMs) spec.nodeMs = spec.handoffMs;
    $('baseline').textContent = `Node baseline: ${baselineSource}`;
    log(`node baseline: ${baselineSource}`);

    const results = [];

    for (const spec of CIRCUITS) {
      const tr = addRow(spec.name);
      $('status').textContent = `proving ${spec.name}…`;
      try {
        results.push(await runCircuit(spec, inputs, tr));
      } catch (e) {
        log(`[${spec.name}] ERROR: ${e.message}`);
        setRow(tr, [{ text: '—' }, { text: '—' }, { text: '—' }, { text: 'error', cls: 'bad' },
          { text: '—' }, { text: '—' }, { text: '—' }]);
      }
    }

    if (results.length) {
      const totalBytes = results.reduce((a, r) => a + r.bytes, 0);
      const firstBet = results.filter((r) => r.name === 'deposit' || r.name === 'bet_encrypted');
      const firstBetBytes = firstBet.reduce((a, r) => a + r.bytes, 0);
      const firstBetMs = firstBet.reduce((a, r) => a + r.proveMs, 0);
      const worst = results.reduce((a, r) => (r.multiplier > a.multiplier ? r : a));

      log('\n———');
      log(`full client   : ${fmtBytes(totalBytes)} across ${results.length} circuits`);
      log(`first bet     : ${fmtBytes(firstBetBytes)} to download, ${fmtMs(firstBetMs)} to prove `
        + '(deposit + bet_encrypted)');
      log(`worst case    : ${worst.name} at ${worst.multiplier.toFixed(2)}× Node`);
      log('\nRecord these numbers in atrum-core HANDOFF.md — they close the '
        + '"browser multiplier is unmeasured" gap.');
      console.table(results.map((r) => ({
        circuit: r.name,
        download: fmtBytes(r.bytes),
        node: `${r.nodeMs} ms`,
        browser: fmtMs(r.proveMs),
        multiplier: `${r.multiplier.toFixed(2)}x`,
      })));
      log('\n(a machine-readable copy is in the devtools console via console.table)');
    }
    $('status').textContent = 'done';
  } catch (e) {
    log(`\nFATAL: ${e.message}`);
    log("if this is a 404, run 'npm run sync' to copy artefacts out of atrum-core.");
    $('status').textContent = 'failed';
  } finally {
    $('runAll').disabled = false;
  }
};

$('clear').onclick = () => {
  rows.innerHTML = '';
  logEl.textContent = 'ready.';
  $('status').textContent = '';
};
