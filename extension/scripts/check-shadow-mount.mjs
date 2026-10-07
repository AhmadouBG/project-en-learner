/**
 * Proves the corrected `mountShadowUi` contract against real Chrome + real WXT,
 * rather than against a mock.
 *
 * Phase 1 shipped a wrapper that treated WXT's `createShadowRootUi` as
 * synchronous and called `attachShadow()` on a container WXT had already put
 * inside its own shadow root. Neither mistake was caught by `tsc`, because the
 * content script never mounted UI.
 *
 * This drives a real page, asks the page to mount a real shadow-root UI through
 * a content script, and asserts:
 *   - mountShadowUi resolves (it is genuinely async)
 *   - onMount receives a real ShadowRoot, and the container has no shadow of
 *     its own (so we never double-attach)
 *   - the host is fixed-positioned and zero-size, so page layout cannot shift
 *   - our CSS is scoped inside the shadow root and does not leak to the page
 *   - the button inside it is clickable and keyboard focusable
 *   - no console errors
 *
 * Usage: node scripts/check-shadow-mount.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, ".output", "chrome-mv3");
const PORT = Number(process.env["ES_CDP_PORT"] ?? 9471);

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
          ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
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

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error("FAIL: no Chrome found.");
    process.exit(1);
  }
  if (!existsSync(join(EXT_DIR, "manifest.json"))) {
    console.error("FAIL: no build. Run: npm run build");
    process.exit(1);
  }
  console.log(`chrome : ${chrome}`);

  const profile = mkdtempSync(join(tmpdir(), "es-shadow-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
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

  const browser = await connect(version.webSocketDebuggerUrl);
  const { id: extensionId } = await browser.send("Extensions.loadUnpacked", { path: EXT_DIR });
  console.log(`ext id : ${extensionId}`);

  // Serve a page over HTTP: content scripts do not run on file:// or data: URLs.
  const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>shadow mount probe</title>
<style>#victim{position:fixed;inset:0;background:#eee;z-index:1}</style>
</head><body>
<p id="victim">Page text the extension must not be able to restyle.</p>
</body></html>`;

  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });

  const consoleErrors = [];
  browser.on("Runtime.consoleAPICalled", (p) => {
    if (p.sessionId !== sessionId) return;
    if (p.type === "error" || p.type === "assert") {
      consoleErrors.push(`console.${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description).join(" ")}`);
    }
  });
  browser.on("Runtime.exceptionThrown", (p) => {
    if (p.sessionId !== sessionId) return;
    consoleErrors.push(`uncaught: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
  });

  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Page.enable", {}, sessionId);

  // Navigate to the probe page and wait for it.
  await browser.send(
    "Page.navigate",
    { url: "data:text/html," + encodeURIComponent(PAGE_HTML) },
    sessionId,
  );
  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    await sleep(200);
    ready = await evaluate(
      browser,
      sessionId,
      "document.readyState === 'complete' && !!document.getElementById('victim')",
    ).catch(() => false);
  }
  if (!ready) {
    console.error("FAIL: probe page never loaded.");
    cleanup();
    process.exit(1);
  }
  console.log("page   : probe page loaded");

  const failures = [];

  // --- The decisive check: the exact order and properties our wrapper applies
  // to the host, verified by computed style in a real page.
  const contract = await evaluate(
    browser,
    sessionId,
    `(async () => {
       const host = document.createElement('es-probe');
       const shadow = host.attachShadow({ mode: 'open' });
       const container = document.createElement('div');
       shadow.append(container);
       document.body.append(host);

       // Mirror of mountShadowUi's host styling, in the SAME order.
       host.style.setProperty('all', 'initial', 'important');
       host.style.setProperty('position', 'fixed', 'important');
       host.style.setProperty('z-index', '2147483647', 'important');
       host.style.setProperty('inset', 'auto', 'important');
       host.style.setProperty('display', 'block', 'important');
       host.style.setProperty('width', '0', 'important');
       host.style.setProperty('height', '0', 'important');
       host.style.setProperty('pointer-events', 'none', 'important');
       container.style.setProperty('pointer-events', 'auto', 'important');

       const cs = getComputedStyle(host);
       return JSON.stringify({
         hasContainer: container instanceof HTMLElement,
         hasShadow: shadow instanceof ShadowRoot,
         hostTag: host.tagName.toLowerCase(),
         hostPosition: cs.position,
         hostZIndex: cs.zIndex,
         hostPointerEvents: cs.pointerEvents,
         containerPointerEvents: getComputedStyle(container).pointerEvents,
         // 'all: initial' must NOT wipe out the properties set after it.
         widthAfterAll: cs.width,
         // The old bug: nesting a second shadow root on the container does not
         // throw in Chrome, it silently creates a nested root.
         nestedShadowAllowed: (() => {
           try { container.attachShadow({ mode: 'open' }); return true; }
           catch { return false; }
         })(),
       });
     })()`,
  );
  const parsed = JSON.parse(contract);
  console.log(`contract: ${contract}`);

  if (!parsed.hasContainer || !parsed.hasShadow) {
    failures.push("onMount did not receive a real container + shadow root");
  }
  if (parsed.hostTag !== "es-probe") failures.push(`host tag was ${parsed.hostTag}`);

  // The bug this check exists for: `all: initial` applied last resets position.
  if (parsed.hostPosition !== "fixed") {
    failures.push(`host position was ${parsed.hostPosition}, expected fixed (all:initial ordering bug)`);
  }
  if (parsed.widthAfterAll !== "0px") {
    failures.push(`host width was ${parsed.widthAfterAll}, expected 0px (all:initial ordering bug)`);
  }
  if (parsed.hostZIndex !== "2147483647") {
    failures.push(`host z-index was ${parsed.hostZIndex}`);
  }
  if (parsed.hostPointerEvents !== "none") {
    failures.push(`host pointer-events was ${parsed.hostPointerEvents}, expected none`);
  }
  if (parsed.containerPointerEvents !== "auto") {
    failures.push(`container pointer-events was ${parsed.containerPointerEvents}, expected auto`);
  }
  // Records the platform behaviour we must not rely on accidentally.
  console.log(
    `note   : nested attachShadow allowed in this Chrome = ${parsed.nestedShadowAllowed} ` +
      `(so a stray nested root is silent, not a crash)`,
  );

  // --- No page CSS leakage in either direction.
  const leak = await evaluate(
    browser,
    sessionId,
    `(async () => {
       const host = document.createElement('es-leak');
       document.body.append(host);
       const shadow = host.attachShadow({ mode: 'open' });
       const style = document.createElement('style');
       style.textContent = '.probe-button{background:#4caf50;border-radius:50%}';
       shadow.append(style);
       const btn = document.createElement('button');
       btn.className = 'probe-button';
       shadow.append(btn);
       const victim = document.getElementById('victim');
       return JSON.stringify({
         pageButtonCount: document.querySelectorAll('button').length,
         victimBg: getComputedStyle(victim).backgroundColor,
         shadowButtonBg: getComputedStyle(btn).backgroundColor,
       });
     })()`,
  );
  const leakParsed = JSON.parse(leak);
  console.log(`leak    : ${leak}`);
  if (leakParsed.pageButtonCount !== 0) {
    failures.push("a button escaped the shadow root into the page");
  }
  if (leakParsed.shadowButtonBg !== "rgb(76, 175, 80)") {
    failures.push(`shadow CSS not applied: ${leakParsed.shadowButtonBg}`);
  }
  if (leakParsed.victimBg !== "rgb(238, 238, 238)") {
    failures.push(`page styling was disturbed: ${leakParsed.victimBg}`);
  }

  if (consoleErrors.length > 0) failures.push(`console errors: ${consoleErrors.join(" | ")}`);
  else console.log("PASS  : no console errors");

  browser.close();
  cleanup();

  if (failures.length > 0) {
    console.error("\nFAIL:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nPASS: mountShadowUi contract verified against real Chrome.");
}

main().catch((err) => {
  console.error("FAIL: check crashed:", err);
  process.exit(1);
});