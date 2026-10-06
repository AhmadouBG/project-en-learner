/**
 * Phase 1 acceptance check against real Chrome (spec 7, Phase 1):
 *   "extension loads, side panel opens from the toolbar icon, no errors in any console"
 *
 * Uses only Node built-ins. Loads the extension through the DevTools
 * `Extensions.loadUnpacked` command rather than `--load-extension`, because
 * headless Chrome ignores the command-line flag on this platform.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, ".output", "chrome-mv3");
const PORT = Number(process.env["ES_CDP_PORT"] ?? 9451);
const HEADED = process.argv.includes("--headed");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const findChrome = () => CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- tiny CDP client -------------------------------------------------------

function connect(wsUrl) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = [];
    let nextId = 1;

    const fail = (err) => {
      for (const { reject: rj } of pending.values()) rj(err);
      pending.clear();
      reject(err);
    };

    ws.addEventListener("open", () =>
      resolvePromise({
        send(method, params = {}, sessionId) {
          const id = nextId++;
          const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
          ws.send(JSON.stringify(message));
          return new Promise((res, rej) => pending.set(id, { res, rej }));
        },
        on(event, fn) {
          listeners.push([event, fn]);
        },
        close: () => ws.close(),
      }),
    );

    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.message} (${msg.method ?? ""})`));
        else res(msg.result);
        return;
      }
      for (const [name, fn] of listeners) if (name === msg.method) fn(msg.params);
    });

    ws.addEventListener("error", () => fail(new Error("CDP socket error")));
    ws.addEventListener("close", () => fail(new Error("CDP socket closed")));
  });
}

/** Evaluate an expression in a session and return its value. */
async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? "evaluation threw");
  }
  return r.result?.value;
}

const describeArgs = (args) =>
  (args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ");

// --- check -----------------------------------------------------------------

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error("FAIL: no Chrome/Chromium binary found.");
    process.exit(1);
  }
  if (!existsSync(join(EXT_DIR, "manifest.json"))) {
    console.error(`FAIL: no build at ${EXT_DIR}. Run: npm run build`);
    process.exit(1);
  }
  console.log(`chrome : ${chrome}`);

  const profile = mkdtempSync(join(tmpdir(), "es-phase1-"));
  const args = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=900,900",
    "about:blank",
  ];
  if (!HEADED) args.unshift("--headless=new");

  const child = spawn(chrome, args, { stdio: "ignore" });
  const cleanup = () => {
    try { child.kill(); } catch { /* gone */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  process.on("exit", cleanup);

  let version = null;
  for (let i = 0; i < 40 && !version; i += 1) {
    await sleep(500);
    version = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      .then((r) => r.json())
      .catch(() => null);
  }
  if (!version) {
    console.error("FAIL: DevTools endpoint never came up.");
    cleanup();
    process.exit(1);
  }
  console.log(`browser: ${version.Browser}`);

  const browser = await connect(version.webSocketDebuggerUrl);

  // 1. Load the unpacked extension and read back the assigned id.
  let extensionId;
  try {
    const res = await browser.send("Extensions.loadUnpacked", { path: EXT_DIR });
    extensionId = res.id;
  } catch (err) {
    console.error(`FAIL: Extensions.loadUnpacked failed: ${err.message}`);
    console.error("      (this Chrome build may not expose the command; try --headed)");
    cleanup();
    process.exit(1);
  }
  console.log(`PASS  : extension loaded, id = ${extensionId}`);

  const failures = [];

  // 2. Confirm the MV3 service worker registered and is running.
  const targets = await waitForTargets(browser, extensionId, "service_worker");
  if (!targets.length) {
    failures.push("no service_worker target appeared for the extension");
  } else {
    console.log(`PASS  : MV3 service worker running (${targets[0].url.split("/").pop()})`);
  }

  // 3. Open the side panel document and assert the tab shell works.
  const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });

  const consoleErrors = [];
  browser.on("Runtime.consoleAPICalled", (p) => {
    if (p.sessionId !== sessionId) return;
    if (p.type !== "error" && p.type !== "assert") return;
    consoleErrors.push(`console.${p.type}: ${describeArgs(p.args)}`);
  });
  browser.on("Runtime.exceptionThrown", (p) => {
    if (p.sessionId !== sessionId) return;
    consoleErrors.push(
      `uncaught: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`,
    );
  });
  browser.on("Log.entryAdded", (p) => {
    if (p.entry.level !== "error") return;
    consoleErrors.push(`log.${p.entry.source}: ${p.entry.text}`);
  });

  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Log.enable", {}, sessionId);
  await browser.send("Page.navigate", { url: panelUrl }, sessionId);

  // Poll for readiness instead of guessing a fixed delay.
  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    await sleep(250);
    ready = await evaluate(
      browser,
      sessionId,
      "document.readyState === 'complete' && !!document.getElementById('tab-practise')",
    ).catch(() => false);
  }
  if (!ready) {
    const diag = await evaluate(
      browser,
      sessionId,
      "JSON.stringify({href:location.href,title:document.title})",
    ).catch((e) => `unavailable: ${e.message}`);
    failures.push(`side panel never loaded; diagnostics ${diag}`);
  } else {
    console.log("PASS  : side panel document loaded");

    const title = await evaluate(browser, sessionId, "document.title");
    const tabCount = await evaluate(
      browser,
      sessionId,
      "document.querySelectorAll('[role=tab]').length",
    );
    const firstSelected = await evaluate(
      browser,
      sessionId,
      "document.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim()",
    );

    // Keyboard path: ArrowRight must move the roving selection and swap panels.
    await evaluate(
      browser,
      sessionId,
      `(() => {
         const t = document.getElementById('tab-practise');
         t.focus();
         t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
         return true;
       })()`,
    );
    await sleep(200);
    const afterArrow = await evaluate(
      browser,
      sessionId,
      "document.querySelector('[role=tab][aria-selected=true]')?.textContent?.trim()",
    );
    const savedVisible = await evaluate(
      browser,
      sessionId,
      "!document.getElementById('panel-saved').hidden",
    );

    console.log(
      `        title=${JSON.stringify(title)} tabs=${tabCount} ` +
        `initial=${JSON.stringify(firstSelected)} afterArrowRight=${JSON.stringify(afterArrow)}`,
    );

    if (title !== "English Shadowing") failures.push(`document.title was ${JSON.stringify(title)}`);
    if (tabCount !== 3) failures.push(`expected 3 tabs, found ${tabCount}`);
    if (firstSelected !== "Practise") failures.push(`first tab not selected (${firstSelected})`);
    if (afterArrow !== "Saved") failures.push(`ArrowRight did not move selection (${afterArrow})`);
    if (!savedVisible) failures.push("Saved tab panel stayed hidden after selection moved");
    if (afterArrow === "Saved" && savedVisible) {
      console.log("PASS  : tabs keyboard operable (roving tabindex + aria-selected)");
    }
  }

  // 4. Any console error anywhere in the panel counts as a failure.
  if (consoleErrors.length > 0) {
    failures.push(`console errors: ${consoleErrors.join(" | ")}`);
  } else {
    console.log("PASS  : no console errors in the side panel");
  }

  // 5. The side panel path is registered in the manifest (what the toolbar
  //    button uses via setPanelBehavior).
  const manifest = JSON.parse(
    await readFileUtf8(join(EXT_DIR, "manifest.json")),
  );
  if (manifest.side_panel?.default_path !== "sidepanel.html") {
    failures.push(`manifest side_panel.default_path is ${manifest.side_panel?.default_path}`);
  } else {
    console.log("PASS  : manifest side_panel.default_path = sidepanel.html");
  }
  const perms = manifest.permissions ?? [];
  const expected = ["contextMenus", "sidePanel", "storage"];
  const missing = expected.filter((p) => !perms.includes(p));
  const extra = perms.filter((p) => !expected.includes(p));
  if (missing.length > 0) failures.push(`manifest missing permissions: ${missing.join(", ")}`);
  if (extra.length > 0) failures.push(`manifest has undeclared-in-spec permissions: ${extra.join(", ")}`);
  console.log(`        permissions = [${perms.join(", ")}]`);

  browser.close();
  cleanup();

  if (failures.length > 0) {
    console.error("\nFAIL:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nPASS: extension loads, side panel renders and is keyboard operable, no console errors.");
}

async function waitForTargets(cdp, extensionId, type) {
  for (let i = 0; i < 30; i += 1) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const hits = targetInfos.filter(
      (t) => t.url.startsWith(`chrome-extension://${extensionId}/`) && t.type === type,
    );
    if (hits.length > 0) return hits;
    await sleep(300);
  }
  return [];
}

import { readFile } from "node:fs/promises";
const readFileUtf8 = (p) => readFile(p, "utf8");

main().catch((err) => {
  console.error("FAIL: check crashed:", err);
  process.exit(1);
});