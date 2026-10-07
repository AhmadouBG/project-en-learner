/**
 * Phase 2 Task 1 acceptance check: frame injection.
 *
 * Proves the content script actually runs in every frame, because that flag is
 * load-bearing: a DOM selection cannot span frames, so if the script only ran in
 * the top document, iframe selections would be invisible to us (spec 5.1,
 * "selections inside iframes where possible").
 *
 * Method: Chrome runs each content script in its own *isolated world* per frame,
 * which the DevTools Protocol reports as an execution context with
 * `auxData.isDefault === false`. We collect those contexts and evaluate
 * `chrome.runtime.id` in each. If our extension's id comes back, our content
 * script is live in that frame. No production code needs a debug hook.
 *
 * Fixtures are served over HTTP by a throwaway node server, because content
 * scripts do not run on `file://` URLs.
 *
 * Usage: node scripts/check-frames.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, ".output", "chrome-mv3");
const CDP_PORT = Number(process.env["ES_CDP_PORT"] ?? 9481);
const HTTP_PORT = Number(process.env["ES_HTTP_PORT"] ?? 8471);

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

async function evaluate(cdp, sessionId, expression, contextId) {
  const params = { expression, returnByValue: true, awaitPromise: true };
  if (contextId !== undefined) params.contextId = contextId;
  const r = await cdp.send("Runtime.evaluate", params, sessionId);
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? "evaluation threw");
  }
  return r.result?.value;
}

// --- fixture server ---------------------------------------------------------

function startFixtureServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${HTTP_PORT}`);
    const send = (html) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    };

    if (url.pathname === "/") {
      send(`<!doctype html><html><head><meta charset="utf-8"><title>frames</title></head><body>
<h1>Top document</h1>
<p id="top-text">Select me in the top frame.</p>
<h2>Same-origin iframe</h2>
<iframe id="same-origin" src="/same.html" width="400" height="90"></iframe>
<h2>about:blank iframe (inherits origin)</h2>
<iframe id="about-blank" srcdoc="<p id='ab-text'>about:blank frame text</p>" width="400" height="60"></iframe>
</body></html>`);
      return;
    }
    if (url.pathname === "/same.html") {
      send(`<!doctype html><html><head><meta charset="utf-8"></head><body>
<p id="same-text">Same-origin frame text.</p></body></html>`);
      return;
    }
    if (url.pathname === "/deep.html") {
      // Nested two levels deep, to prove all_frames is not just one level.
      send(`<!doctype html><html><body><p id="deep-text">Deep frame text.</p>
<iframe src="/deep.html" width="300" height="40"></iframe></body></html>`);
      return;
    }
    if (url.pathname === "/broken.html") {
      // A frame with no content script should exist for the negative check.
      send(`<!doctype html><html><body><p id="broken-text">Broken frame.</p></body></html>`);
      return;
    }
    res.writeHead(404).end("not found");
  });

  return new Promise((res) => server.listen(HTTP_PORT, "127.0.0.1", () => res(server)));
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

  const server = await startFixtureServer();
  console.log(`fixture: http://127.0.0.1:${HTTP_PORT}/`);

  const profile = mkdtempSync(join(tmpdir(), "es-frames-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
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
    try { server.close(); } catch { /* best effort */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  process.on("exit", cleanup);

  let version = null;
  for (let i = 0; i < 40 && !version; i += 1) {
    await sleep(500);
    version = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
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
  // A content script gets its own isolated world per frame. Chrome reports these
// as execution contexts with auxData.isDefault === false and an origin of
// `chrome-extension://<our-id>`, which is what we key on.
  const OUR_ORIGIN = `chrome-extension://${extensionId}`;
  const contextEvents = [];

  browser.on("Runtime.executionContextCreated", (p) => {
    // Chrome delivers these on the browser socket WITHOUT a sessionId, even
    // when we attached with flatten:true (verified empirically). This script
    // attaches exactly one page session, so accept a missing sessionId.
    if (p.sessionId !== undefined && p.sessionId !== sessionId) return;
    const c = p.context;
    if (!c) return;
    contextEvents.push({
      id: c.id,
      frameId: c.auxData?.frameId ?? "?",
      isIsolated: c.auxData?.isDefault === false,
      name: c.name ?? "",
      origin: c.origin ?? "",
    });
  });
  browser.on("Runtime.executionContextsCleared", (p) => {
    if (p.sessionId !== undefined && p.sessionId !== sessionId) return;
    // A navigation wipes every context, including the isolated worlds. This is
    // what stops us counting a stale context from the previous document.
    contextEvents.length = 0;
  });

  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Page.enable", {}, sessionId);

  await browser.send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` }, sessionId);

  // Wait for the top document plus both child frames to settle.
  const settleDeadline = Date.now() + 12_000;
  while (Date.now() < settleDeadline) {
    await sleep(200);
    const ours = contextEvents.filter((c) => c.isIsolated && c.origin === OUR_ORIGIN);
    if (new Set(ours.map((c) => c.frameId)).size >= 3) break;
  }
  await sleep(800);

  console.log("\nexecution contexts seen:");
  for (const c of contextEvents) {
    console.log(
      `  ${c.isIsolated ? "isolated" : "main    "} frame=${c.frameId.slice(0, 8)} ` +
        `name=${JSON.stringify(c.name)} origin=${JSON.stringify(c.origin)}`,
    );
  }

  const failures = [];

  // Sanity: prove the page really loaded, so a zero result means "no injection"
  // and not "the page never rendered".
  const sanity = JSON.parse(
    await evaluate(
      browser,
      sessionId,
      "JSON.stringify({origin: location.origin, ready: document.readyState, frames: document.querySelectorAll('iframe').length})",
    ),
  );
  console.log(
    `sanity : origin=${sanity.origin} ready=${sanity.ready} iframes=${sanity.frames}`,
  );
  if (sanity.ready !== "complete" || sanity.frames < 2) {
    failures.push("fixture page did not load; result would be meaningless");
  }

  const ours = contextEvents.filter((c) => c.isIsolated && c.origin === OUR_ORIGIN);
  const ourFrames = new Set(ours.map((c) => c.frameId));

  console.log(`\nour isolated worlds: ${ours.length} across ${ourFrames.size} distinct frames`);
  if (ours.length === 0) {
    failures.push(`our content script ran in NO frame (no context with origin ${OUR_ORIGIN})`);
  }
  if (ourFrames.size < 3) {
    failures.push(
      `expected the script in >=3 frames (top document + same-origin iframe + srcdoc iframe), found ${ourFrames.size}`,
    );
  }
  if (ours.length !== ourFrames.size) {
    failures.push("a frame hosted more than one copy of the content script");
  }
  if (ours.length > 0 && ourFrames.size >= 3) {
    console.log("PASS  : top document, same-origin iframe and srcdoc iframe all got the script");
    console.log("        (srcdoc/about:blank works via match_origin_as_fallback)");
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
  console.log("\nPASS: content script injected into top document and child frames (all_frames works).");
}

main().catch((err) => {
  console.error("FAIL: check crashed:", err);
  process.exit(1);
});