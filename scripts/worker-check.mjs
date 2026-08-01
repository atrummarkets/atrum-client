/**
 * Drive the worker A/B headlessly.
 *
 * The Web Worker decision was made on a measurement (bet_encrypted froze the main thread for
 * 388ms), so the implementation deserves a measurement too rather than an assumption that
 * moving code into a worker had the intended effect.
 *
 * Fails the build if the worker does not actually keep the page responsive.
 *
 * Usage: npm run worker-check
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || 8124;

const CHROME =
  process.env.CHROME_PATH ||
  join(process.env.HOME, ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");

if (!existsSync(CHROME)) {
  console.error(`\nNo browser at ${CHROME}. Set CHROME_PATH.\n`);
  process.exit(1);
}

const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);

const server = spawn("npx", ["http-server", ".", "-p", String(PORT), "-c-1", "--silent"], {
  cwd: ROOT,
  stdio: "ignore",
});
const shutdown = () => {
  try {
    server.kill();
  } catch {
    /* already gone */
  }
};
process.on("exit", shutdown);

const url = `http://127.0.0.1:${PORT}/worker-check.html`;
for (let i = 0; i < 75; i++) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}

const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.click("#run");
await page.waitForFunction(() => window.__abDone === true, null, { timeout: 300000 });

const err = await page.evaluate(() => window.__abError);
if (err) {
  console.error(`\nA/B failed: ${err}`);
  if (errors.length) console.error(`page errors:\n  ${errors.join("\n  ")}`);
  await browser.close();
  shutdown();
  process.exit(1);
}

const r = await page.evaluate(() => window.__abResults);

console.log(`\nbet_encrypted — main thread vs worker (headless Chromium ${browser.version()})`);
console.log("=".repeat(68));
console.log("mode".padEnd(16) + "prove".padStart(10) + "stall".padStart(10) + "  UI".padEnd(14) + "verified");
console.log("-".repeat(68));
for (const [mode, v] of Object.entries(r)) {
  console.log(
    mode.padEnd(16) +
      fmt(v.proveMs).padStart(10) +
      fmt(v.stallMs).padStart(10) +
      `  ${v.stallMs > 100 ? "frozen" : "responsive"}`.padEnd(14) +
      (v.verified ? "ok" : "FAILED"),
  );
}
console.log("=".repeat(68));

await browser.close();
shutdown();

const problems = [];
if (!r.inline.verified || !r.worker.verified) problems.push("a proof failed to verify");
if (r.worker.stallMs > 100)
  problems.push(`worker still stalls the main thread for ${fmt(r.worker.stallMs)}`);
if (!r.worker.hasCalldata) problems.push("worker did not return Solidity calldata");

if (problems.length) {
  console.error(`\nFAILED:\n  - ${problems.join("\n  - ")}\n`);
  process.exit(1);
}

console.log(
  `\nThe worker holds the main thread for ${fmt(r.worker.stallMs)} against ` +
    `${fmt(r.inline.stallMs)} inline.\nProving is off the main thread and the page stays responsive.\n`,
);
process.exit(0);
