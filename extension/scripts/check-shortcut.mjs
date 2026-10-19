/**
 * Phase 11 check: the Alt+Shift+S shortcut opens the quick-read pop-up for the
 * current selection (spec 5.9), and the pop-up can hand the phrase to the panel.
 *
 * Loads the built extension, serves a page over HTTP (content scripts do not run
 * on file: or data: URLs), selects a sentence, sends the real Alt+Shift+S key
 * chord through the DevTools Protocol, and asserts the pop-up mounts inside its
 * shadow root.
 *
 * Usage: node scripts/check-shortcut.mjs [--headed]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, ".output", "chrome-mv3");
const PORT = Number(process.env["ES_CDP_PORT"] ?? 9501);
const HTTP_PORT = Number(process.env["ES_HTTP_PORT"] ?? 8751);
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

function connect(wsUrl) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const listeners = [];
    let nextId = 1;

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

    ws.addEventListener("error", () => reject(new Error("CDP socket error")));
  });
}

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

async function waitFor(cdp, sessionId, expression, { attempts = 50, interval = 200 } = {}) {
  let value = false;
  for (let i = 0; i < attempts; i += 1) {
    value = await evaluate(cdp, sessionId, expression).catch(() => false);
    if (value) return value;
    await sleep(interval);
  }
  return value;
}

const describeArgs = (args) =>
  (args ?? []).map((a) => a.value ?? a.description ?? a.type).join(" ");

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

  const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>shortcut probe</title></head>
<body>
  <p id="middle">Could you schedule the meeting for tomorrow?</p>
</body></html>`;

  const server = await new Promise((r) => {
    const s = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
    });
    s.listen(HTTP_PORT, "127.0.0.1", () => r(s));
  });

  const profile = mkdtempSync(join(tmpdir(), "es-shortcut-"));
  const args = [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "about:blank",
  ];
  if (HEADED) args.splice(args.indexOf("--headless=new"), 1);

  const child = spawn(chrome, args, { stdio: "ignore" });
  const cleanup = () => {
    try { child.kill(); } catch { /* gone */ }
    try { server.close(); } catch { /* gone */ }
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
  const { id: extensionId } = await browser.send("Extensions.loadUnpacked", { path: EXT_DIR });
  console.log(`ext id : ${extensionId}`);

  const pageUrl = `http://127.0.0.1:${HTTP_PORT}/`;
  const { targetId } = await browser.send("Target.createTarget", { url: pageUrl });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });

  const failures = [];
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

  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Page.bringToFront", {}, sessionId);

  const loaded = await waitFor(
    browser,
    sessionId,
    "document.readyState === 'complete' && !!document.getElementById('middle')",
  );
  if (!loaded) {
    failures.push("probe page never loaded");
  } else {
    console.log("PASS  : probe page loaded");
  }

  // Select the sentence the same way a drag would end. Re-select a few times:
  // injection happens at document_idle and the watcher only reacts to events
  // after it is installed, so a single synthetic mouseup can land too early.
  const selectSentence = `(async () => {
     const el = document.getElementById('middle');
     const range = document.createRange();
     range.selectNodeContents(el);
     const sel = getSelection();
     sel.removeAllRanges();
     sel.addRange(range);
     document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
     await new Promise((r) => setTimeout(r, 300));
     return true;
   })()`;
  let buttonReady = false;
  for (let i = 0; i < 8 && !buttonReady; i += 1) {
    await evaluate(browser, sessionId, selectSentence);
    buttonReady = await waitFor(
      browser,
      sessionId,
      "!!document.querySelector('es-micro-button')",
      { attempts: 8, interval: 200 },
    );
  }
  if (!buttonReady) failures.push("micro-button never appeared for the selection");
  else {
    console.log("PASS  : selection produced the micro-button");
    // The label is the visible proof that the content script got a real message
    // bag: before the background relay, this read literally "microButtonLabel".
    const buttonLabel = await evaluate(
      browser,
      sessionId,
      `document.querySelector('es-micro-button')?.shadowRoot?.querySelector('button')?.getAttribute('aria-label') ?? ''`,
    );
    if (buttonLabel === "" || /^[a-z][A-Za-z]*$/.test(buttonLabel)) {
      failures.push(`micro-button label was not translated (${JSON.stringify(buttonLabel)})`);
    } else {
      console.log(`PASS  : micro-button label is translated (${JSON.stringify(buttonLabel)})`);
    }
  }

  // The real key chord: Alt=1, Shift=8 in CDP bit flags.
  const chord = {
    modifiers: 9,
    key: "S",
    code: "KeyS",
    windowsVirtualKeyCode: 83,
    nativeVirtualKeyCode: 83,
  };
  await browser.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...chord }, sessionId);
  await browser.send("Input.dispatchKeyEvent", { type: "keyUp", ...chord }, sessionId);

  const popupOpen = await waitFor(
    browser,
    sessionId,
    `(() => {
       const host = document.querySelector('es-quick-popup');
       const pop = host?.shadowRoot?.querySelector('.es-pop');
       return !!pop;
     })()`,
    { attempts: 40 },
  );
  if (!popupOpen) {
    const diagnostic = await evaluate(
      browser,
      sessionId,
      `(async () => {
         const bag = await chrome.storage.local.get('es.store').catch(() => null);
         return JSON.stringify({
           popups: document.querySelectorAll('es-quick-popup').length,
           notice: bag?.['es.store']?.session?.notice ?? null,
           target: bag?.['es.store']?.session?.target?.text ?? null,
         });
       })()`,
    ).catch((e) => `unavailable: ${e.message}`);
    failures.push(`Alt+Shift+S did not open the quick-read pop-up (${diagnostic})`);
  } else {
    console.log("PASS  : Alt+Shift+S opened the quick-read pop-up");
    const title = await evaluate(
      browser,
      sessionId,
      `(() => {
         const host = document.querySelector('es-quick-popup');
         const pop = host?.shadowRoot?.querySelector('.es-pop');
         return pop?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 160) ?? '';
       })()`,
    );
    console.log(`        pop-up text: ${JSON.stringify(title)}`);
    if (!title.includes("Could you schedule the meeting")) {
      failures.push("pop-up did not show the selected sentence");
    } else {
      console.log("PASS  : pop-up shows the selected text");
    }
    // Translatable labels must be rendered, not their keys.
    const rawKeys = title.match(/\b(popup|btn|es-)[A-Za-z]+\b/g) ?? [];
    if (rawKeys.length > 0) {
      failures.push(`pop-up rendered raw message keys: ${rawKeys.join(", ")}`);
    } else if (!title.includes("Listen") || !title.includes("IPA per word")) {
      failures.push("pop-up did not render the translated controls");
    } else {
      console.log("PASS  : pop-up labels are translated, not raw keys");
    }
  }

  if (consoleErrors.length > 0) {
    failures.push(`console errors: ${consoleErrors.join(" | ")}`);
  } else {
    console.log("PASS  : no console errors");
  }

  browser.close();
  cleanup();

  if (failures.length > 0) {
    console.error("\nFAIL:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nPASS: the Alt+Shift+S shortcut opens the quick-read pop-up for a selection.");
}

main().catch((err) => {
  console.error("FAIL: check crashed:", err);
  process.exit(1);
});
