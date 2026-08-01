/**
 * Drive the fresh-note proof headlessly, and fail if the client and the circuit disagree.
 *
 * This is the seam check: a note invented in the browser, a witness built by the client, and
 * a proof verified against the circuit's own verification key. It needs no chain, no
 * sequencer and no funded key, so it can run in CI -- which matters, because the three real
 * bugs this project has found all lived in seams between individually-correct components.
 *
 * Usage: npm run fresh-note
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || 8125;

const CHROME =
  process.env.CHROME_PATH ||
  join(process.env.HOME, ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");

if (!existsSync(CHROME)) {
  console.error(`\nNo browser at ${CHROME}. Set CHROME_PATH.\n`);
  process.exit(1);
}

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

const url = `http://127.0.0.1:${PORT}/fresh-note.html`;
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
await page.waitForFunction(() => window.__freshNoteDone === true, null, { timeout: 300000 });

const err = await page.evaluate(() => window.__freshNoteError);
if (err) {
  console.error(`\nfresh-note check failed: ${err}`);
  if (errors.length) console.error(`page errors:\n  ${errors.join("\n  ")}`);
  await browser.close();
  shutdown();
  process.exit(1);
}

const r = await page.evaluate(() => window.__freshNote);
await browser.close();
shutdown();

console.log("\nFresh-note deposit proof — client-built witness vs the real circuit");
console.log("=".repeat(70));
console.log(`  commitment            ${r.commitment}`);
console.log(`  proved in             ${Math.round(r.proveMs)}ms`);
console.log(`  verifies against vkey ${r.ok ? "yes" : "NO"}`);
console.log(`  signals match note    ${r.signalsMatch ? "yes" : "NO"}`);
console.log(`  Solidity calldata     ${r.hasCalldata ? "yes" : "NO"}`);
console.log("=".repeat(70));

if (!r.ok || !r.signalsMatch || !r.hasCalldata) {
  console.error(
    "\nFAILED. The client's witness building does not agree with the circuit.\n" +
      "Do not submit anything built by this client until it does.\n",
  );
  process.exit(1);
}

console.log(
  "\nThe client derives the same commitment note.circom does, from a note the repo\n" +
    "never saw. The witness-building seam is sound; only on-chain submission is untested.\n",
);
process.exit(0);
