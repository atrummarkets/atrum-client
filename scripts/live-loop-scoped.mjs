/**
 * Drive the real app.html UI headlessly, with a real funded wallet.
 *
 * This is the strongest verification available short of a human clicking buttons: it
 * exercises app.js/wallet.mjs/notes.mjs exactly as written, through the actual page, with
 * real transactions on real testnet. The only thing simulated is the wallet extension --
 * `window.ethereum` is a thin shim that signs and broadcasts through a real `ethers.Wallet`
 * rather than prompting a human, everything else (proving, calldata, contract calls) is the
 * genuine client code path.
 *
 * Usage:
 *   PRIVATE_KEY=0x... node scripts/live-loop.mjs deposit [units]
 *   PRIVATE_KEY=0x... node scripts/live-loop.mjs bet <side: YES|NO>
 *   PRIVATE_KEY=0x... node scripts/live-loop.mjs redeem
 *   PRIVATE_KEY=0x... node scripts/live-loop.mjs withdraw <amount>
 *   PRIVATE_KEY=0x... node scripts/live-loop.mjs status
 *
 * Each run is a fresh browser context with fresh IndexedDB, EXCEPT it reuses a persistent
 * user-data-dir so notes created in one run (e.g. deposit) are still there for the next
 * (e.g. bet) -- matching how a real user would actually use this across sessions.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || 8126;
const PROFILE_DIR = join(ROOT, ".live-loop-profile");

const CHROME =
  process.env.CHROME_PATH ||
  join(process.env.HOME, ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("PRIVATE_KEY env var required (testnet-only key).");
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`No browser at ${CHROME}. Set CHROME_PATH.`);
  process.exit(1);
}

const [cmd, arg] = process.argv.slice(2);
if (!cmd) {
  console.error("usage: live-loop.mjs <deposit|bet|redeem|withdraw|status> [arg]");
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

const url = `http://127.0.0.1:${PORT}/app.html`;
for (let i = 0; i < 75; i++) {
  try {
    if ((await fetch(url)).ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 200));
}

// A REAL browser profile directory, not an incognito context -- IndexedDB (where notes
// live) must persist across separate invocations of this script, the same way it persists
// across tabs for a real user.
const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  executablePath: CHROME,
  args: ["--no-sandbox"],
});
const page = context.pages()[0] ?? (await context.newPage());

const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

/**
 * The wallet shim. Reads (eth_call, gas estimation, block info, nonce, everything the
 * BrowserProvider needs to populate a transaction) go straight to the real RPC. Writes
 * (eth_sendTransaction) are signed and broadcast by a real ethers.Wallet holding
 * PRIVATE_KEY. From app.js's perspective this is indistinguishable from MetaMask.
 */
await page.addInitScript(
  ({ privateKey, rpcUrl, relay }) => {
    // Relaying defaults ON in the client, and the sequencer only accepts /relay when it was
    // started with RELAY_MNEMONIC. Forcing the flag here means a run against a
    // relaying-disabled sequencer fails on the assertion it was written for, rather than on
    // a 404 from an endpoint that was never enabled.
    try {
      localStorage.setItem("atrumRelay", relay);
    } catch {
      // A page that has not loaded yet has no storage; app.js reads it lazily, so this is
      // best-effort and its absence just means the client default applies.
    }

    window.__installWallet = async () => {
      const { ethers } = await import("./public/vendor/ethers.min.js");
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const wallet = new ethers.Wallet(privateKey, provider);

      window.ethereum = {
        isMetaMask: true,
        selectedAddress: wallet.address,
        chainId: "0x279f",
        async request({ method, params }) {
          switch (method) {
            case "eth_requestAccounts":
            case "eth_accounts":
              return [wallet.address];
            case "eth_chainId":
              return "0x279f";
            case "wallet_switchEthereumChain":
            case "wallet_addEthereumChain":
              return null;
            case "eth_sendTransaction": {
              const sent = await wallet.sendTransaction(params[0]);
              return sent.hash;
            }
            default:
              return provider.send(method, params ?? []);
          }
        },
        on() {},
        removeListener() {},
      };
    };
  },
  {
    privateKey: PRIVATE_KEY,
    // The public endpoint reported "Signer had insufficient balance" for a transaction that
    // succeeded verbatim through Ankr, on a wallet holding 8.37 MON. See
    // atrum-core/sequencer/src/chains.ts for the full elimination.
    rpcUrl: process.env.RPC_URL || "https://rpc.ankr.com/monad_testnet",
    relay: process.env.ATRUM_RELAY || "on",
  },
);

await page.goto(url, { waitUntil: "domcontentloaded" });
await page.evaluate(() => window.__installWallet());
await page.click("#connect");
await page.waitForFunction(
  () => document.getElementById("account").textContent.startsWith("0x"),
  null,
  { timeout: 20000 },
);

const account = await page.textContent("#account");
console.log(`connected: ${account}`);

async function waitLogContains(substr, timeoutMs = 240000) {
  await page.waitForFunction(
    (s) => document.getElementById("log").textContent.includes(s),
    substr,
    { timeout: timeoutMs },
  );
}

async function drainLog() {
  const text = await page.textContent("#log");
  console.log(text.trim().split("\n").slice(-25).join("\n"));
}

async function fail(msg) {
  await drainLog();
  console.error(`\n${msg}`);
  if (errors.length) console.error(`page errors:\n  ${errors.join("\n  ")}`);
  await context.close();
  shutdown();
  process.exit(1);
}

if (cmd === "status") {
  await page.click("#refresh-notes");
  await new Promise((r) => setTimeout(r, 500));
  const rows = await page.$$eval("#notes-body tr", (trs) =>
    trs.map((tr) => Array.from(tr.children).map((td) => td.textContent.trim())),
  );
  console.log("notes:");
  for (const r of rows) console.log("  " + r.join(" | "));
} else if (cmd === "deposit") {
  // No market is selected, and none can be: a deposit names no market. The button is enabled
  // by `showPool`, which reads the pool's own collateral and denomination, so waiting on the
  // button is waiting on the only thing a deposit actually depends on.
  if (arg) await page.selectOption("#units", arg);
  await page.waitForFunction(() => !document.getElementById("deposit").disabled, null, {
    timeout: 30000,
  });
  await page.click("#deposit");
  await Promise.race([waitLogContains("DEPOSITED"), waitLogContains("FAILED")]);
  await drainLog();
  const logText = await page.textContent("#log");
  if (!logText.includes("DEPOSITED")) await fail("deposit did not report DEPOSITED");
} else if (cmd === "bet") {
  const side = (arg || "YES").toUpperCase();
  const prefix = process.env.COMMITMENT_PREFIX;
  const btnSelector = prefix
    ? `#notes-body button[data-act="bet"][data-side="${side === "YES" ? "1" : "2"}"][data-c^="${prefix}"]`
    : `#notes-body button[data-act="bet"][data-side="${side === "YES" ? "1" : "2"}"]`;
  await page.click("#refresh-notes");
  await page.waitForTimeout(800);
  await page.waitForSelector(btnSelector, { timeout: 20000 });
  await page.click(btnSelector);
  await Promise.race([waitLogContains("BET landed"), waitLogContains("BET FAILED")]);
  await drainLog();
  const logText = await page.textContent("#log");
  if (!logText.includes("BET landed")) await fail("bet did not report BET landed");
} else if (cmd === "redeem") {
  // COMMITMENT_PREFIX scopes to one note: the persistent profile accumulates notes across
  // every pool this script has ever pointed at, and an unscoped selector clicks whichever
  // matching button is first in DOM order -- which may belong to a stale note from an
  // earlier, now-orphaned pool.
  const prefix = process.env.COMMITMENT_PREFIX;
  const btnSelector = prefix
    ? `#notes-body button[data-act="redeem"][data-c^="${prefix}"]`
    : '#notes-body button[data-act="redeem"]';
  await page.click("#refresh-notes");
  await page.waitForTimeout(800); // renderNotes() rebuilds the table asynchronously
  await page.waitForSelector(btnSelector, { timeout: 20000 });
  await page.click(btnSelector);
  await Promise.race([waitLogContains("REDEEMED"), waitLogContains("REDEEM FAILED")]);
  await drainLog();
  const logText = await page.textContent("#log");
  if (!logText.includes("REDEEMED")) await fail("redeem did not report REDEEMED");
} else if (cmd === "withdraw") {
  const prefix = process.env.COMMITMENT_PREFIX;
  const amtSelector = prefix ? `input[data-amt^="${prefix}"]` : 'input[data-amt]';
  const btnSelector = prefix
    ? `#notes-body button[data-act="withdraw"][data-c^="${prefix}"]`
    : '#notes-body button[data-act="withdraw"]';
  await page.click("#refresh-notes");
  await page.waitForTimeout(800); // renderNotes() rebuilds the table asynchronously
  await page.waitForSelector(amtSelector, { timeout: 20000 });
  if (arg) await page.fill(amtSelector, arg);
  if (process.env.RECIPIENT) {
    const recipientSelector = prefix ? `input[data-recipient^="${prefix}"]` : 'input[data-recipient]';
    await page.fill(recipientSelector, process.env.RECIPIENT);
  }
  await page.click(btnSelector);
  await Promise.race([waitLogContains("WITHDRAWN"), waitLogContains("WITHDRAW FAILED")]);
  await drainLog();
  const logText = await page.textContent("#log");
  if (!logText.includes("WITHDRAWN")) await fail("withdraw did not report WITHDRAWN");
} else {
  console.error(`unknown command '${cmd}'`);
}

await context.close();
shutdown();
process.exit(0);
