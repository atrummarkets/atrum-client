/**
 * Measure Groth16 proving in a real browser engine, headlessly.
 *
 * This closes the question atrum-core's HANDOFF.md has carried since the proving spike:
 * Node timings are a LOWER BOUND and the browser multiplier was never measured. It decides
 * the whole client architecture, because a user cannot place a first bet without downloading
 * 11.8MB of `bet_encrypted` artefacts and proving in their tab.
 *
 * It drives `harness.html` rather than reimplementing the measurement, so a headless run and
 * a human clicking Run go through exactly the same code path — the harness fetches, proves,
 * verifies and records the frame stall, and this script only scrapes what it published.
 *
 * HEADLESS IS A FAIR MEASUREMENT, WITH ONE CAVEAT. Headless Chromium runs the same V8 and
 * the same wasm engine as a headed browser, and proving is pure compute with no rendering in
 * the loop. What headless does NOT reproduce is contention with a real page's paint and
 * layout work, so the frame stalls reported here are, if anything, optimistic. Record the
 * numbers as headless rather than implying otherwise.
 *
 * Usage: npm run browser-baseline
 */

import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || 8123;

// Use the browser that is already on this machine. Playwright would otherwise want to
// download its own, which is a 150MB fetch for a binary we already have.
const CHROME =
  process.env.CHROME_PATH ||
  join(
    process.env.HOME,
    ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  );

if (!existsSync(CHROME)) {
  console.error(
    `\nNo browser at ${CHROME}\n` +
      "Set CHROME_PATH to a Chromium/Chrome binary, or run `npx playwright install chromium`.\n",
  );
  process.exit(1);
}

if (!existsSync(join(ROOT, "public", "fixtures", "witness-inputs.json"))) {
  console.error("\nNo synced artefacts. Run `npm run sync` first.\n");
  process.exit(1);
}

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const mb = (b) => `${(b / 1024 ** 2).toFixed(1)}MB`;

// Serve the harness. `-c-1` disables caching so each run measures a cold fetch.
const server = spawn(
  "npx",
  ["http-server", ".", "-p", String(PORT), "-c-1", "--silent"],
  { cwd: ROOT, stdio: "ignore" },
);

const shutdown = () => {
  try {
    server.kill();
  } catch {
    /* already gone */
  }
};
process.on("exit", shutdown);
process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});

// Give the server a moment, then poll until it answers.
async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start on ${url}`);
}

const url = `http://127.0.0.1:${PORT}/harness.html`;
await waitForServer(url);

const browser = await chromium.launch({
  executablePath: CHROME,
  // --enable-precise-memory-info makes performance.memory usable rather than bucketed.
  args: ["--enable-precise-memory-info", "--no-sandbox"],
});

const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(url, { waitUntil: "domcontentloaded" });

const version = browser.version();
console.log(`\nGroth16 proving, headless Chromium ${version}`);
console.log("=".repeat(78));

await page.click("#runAll");

// bet_encrypted alone is ~11.8MB to fetch and a second or more to prove; four circuits with
// a cold cache needs real headroom.
await page.waitForFunction(() => window.__harnessDone === true, null, {
  timeout: 300000,
});

const err = await page.evaluate(() => window.__harnessError);
if (err) {
  console.error(`\nharness failed: ${err}\n`);
  await browser.close();
  shutdown();
  process.exit(1);
}

const { results, baselineSource, totalBytes } = await page.evaluate(
  () => window.__harnessResults,
);

console.log(`baseline: ${baselineSource}`);
console.log("-".repeat(78));
console.log(
  "circuit".padEnd(16) +
    "download".padStart(10) +
    "node".padStart(10) +
    "browser".padStart(10) +
    "mult".padStart(8) +
    "stall".padStart(10) +
    "  verified",
);
console.log("-".repeat(78));

for (const r of results) {
  console.log(
    r.name.padEnd(16) +
      mb(r.bytes).padStart(10) +
      fmt(r.nodeMs).padStart(10) +
      fmt(r.proveMs).padStart(10) +
      `${r.multiplier.toFixed(2)}x`.padStart(8) +
      fmt(r.frameStallMs).padStart(10) +
      `  ${r.verified ? "ok" : "NOT VERIFIED"}`,
  );
}

console.log("=".repeat(78));

const worstStall = results.reduce((a, r) => (r.frameStallMs > a.frameStallMs ? r : a));
const worstMult = results.reduce((a, r) => (r.multiplier > a.multiplier ? r : a));
const unverified = results.filter((r) => !r.verified);

console.log(`full client : ${mb(totalBytes)} across ${results.length} circuits`);
console.log(
  `worst mult  : ${worstMult.name} at ${worstMult.multiplier.toFixed(2)}x Node`,
);
console.log(
  `worst stall : ${worstStall.name} held the main thread ${fmt(worstStall.frameStallMs)}`,
);
console.log(
  `\nVERDICT     : ${
    worstStall.frameStallMs > 100
      ? "proving MUST run in a Web Worker. The main thread is unusable during it."
      : "main-thread proving is survivable; a Worker is optional."
  }\n`,
);

writeFileSync(
  join(ROOT, "browser-baseline.json"),
  `${JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      runtime: `headless chromium ${version}`,
      headless: true,
      baselineSource,
      totalBytes,
      circuits: Object.fromEntries(results.map((r) => [r.name, r])),
    },
    null,
    2,
  )}\n`,
);
console.log("wrote browser-baseline.json");

if (pageErrors.length) {
  console.error(`\npage errors:\n  ${pageErrors.join("\n  ")}\n`);
}

await browser.close();
shutdown();
process.exit(unverified.length ? 1 : 0);
