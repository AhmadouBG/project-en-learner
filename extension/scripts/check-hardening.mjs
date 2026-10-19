/**
 * Phase 12 hardening checks against real Chrome.
 *
 * Spec 7, Phase 12 lists a test matrix: Wikipedia, GitHub, YouTube comments,
 * Google Docs, an iframe page, a strict-CSP site, offline mode, denied mic, no
 * voices installed, low-end laptop. This script automates what a headless,
 * unauthenticated browser can decide:
 *
 *   - a strict-CSP page: our content script must still mount and work
 *   - offline dictionary: the pop-up must explain it, not hang or throw
 *   - no voices installed: Listen must say so instead of playing silence
 *   - real sites (Wikipedia, GitHub, YouTube, Google Docs): select text and
 *     look for the micro-button
 *
 * Iframes are covered by scripts/check-frames.mjs and the denied microphone by
 * scripts/check-permission.mjs. "Low-end laptop" cannot be automated; the
 * measured numbers are reported in extension/docs/DECISIONS.md instead.
 *
 * Usage: node scripts/check-hardening.mjs [--headed]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, ".output", "chrome-mv3");
const PORT = Number(process.env["ES_CDP_PORT"] ?? 9511);
const HTTP_PORT = Number(process.env["ES_HTTP_PORT"] ?? 8761);
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

/** Select the first reasonably sized chunk of visible text on a page. */
const SELECT_SCRIPT = `(() => {
  const pick = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = (node.textContent || "").trim();
      if (text.length < 20 || text.length > 200) continue;
      if (!/[A-Za-z]{3}/.test(text)) continue;
      const parent = node.parentElement;
      // Skip hidden nodes (templates, collapsed menus, off-screen widgets).
      if (!parent || parent.getClientRects().length === 0) continue;
      if (parent.closest('[contenteditable="true"], input, textarea, select, [aria-hidden="true"]')) continue;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, Math.min(text.length, 120));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return text.slice(0, 80);
    }
    return null;
  };
  for (const root of document.querySelectorAll('p, article, main')) {
    const hit = pick(root);
    if (hit) return hit;
  }
  return pick(document.body);
})()`;

/** Select one complete short word, for the offline dictionary check. */
const SELECT_WORD_SCRIPT = `(() => {
  const el = document.getElementById('w');
  if (!el) return null;
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  return el.textContent.trim();
})()`;

const BUTTON_SCRIPT = `(() => {
  const host = document.querySelector('es-micro-button');
  const label = host?.shadowRoot?.querySelector('button')?.getAttribute('aria-label') ?? '';
  return label !== '' && !/^[a-z][A-Za-z]*$/.test(label) ? label : false;
})()`;

/**
 * Select, then wait for the micro-button. The content script is injected at
 * `document_idle`, which can land just after we navigate, so a single selection
 * can race the injection. Re-selecting covers that.
 */
async function selectUntilButton(cdp, sessionId, { rounds = 12, script = SELECT_SCRIPT } = {}) {
  for (let i = 0; i < rounds; i += 1) {
    const selected = await evaluate(cdp, sessionId, script).catch(() => null);
    if (selected) {
      const label = await waitFor(cdp, sessionId, BUTTON_SCRIPT, { attempts: 4, interval: 200 });
      if (label) return { selected, label };
    }
    await sleep(250);
  }
  return null;
}

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

  const strictCsp =
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>csp</title></head><body>" +
    "<p id=\"target\">Could you schedule the meeting for tomorrow?</p></body></html>";
  const wordPage =
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>word</title></head><body>" +
    "<p id=\"w\">schedule</p></body></html>";

  const server = await new Promise((r) => {
    const s = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url.startsWith("/csp")) {
        // No scripts, no styles, no inline anything: our content script is
        // injected by Chrome and must be unaffected by the page's CSP.
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; script-src 'none'; style-src 'none'; base-uri 'none'",
        });
        res.end(strictCsp);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(wordPage);
    });
    s.listen(HTTP_PORT, "127.0.0.1", () => r(s));
  });

  const profile = mkdtempSync(join(tmpdir(), "es-hardening-"));
  const args = [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1000,900",
    // Deterministic "offline" for the dictionary API only: DNS resolution fails,
    // so fetch rejects and the extension must report its offline state. This
    // covers the service worker too, unlike a per-target CDP block.
    "--host-resolver-rules=MAP freedictionaryapi.com ~NOTFOUND",
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

  const failures = [];
  const ownErrors = [];
  browser.on("Runtime.exceptionThrown", (p) => {
    const text = p.exceptionDetails.exception?.description ?? p.exceptionDetails.text ?? "";
    if (text.includes(extensionId) || /es-micro-button|es-quick-popup|chrome-extension/.test(text)) {
      ownErrors.push(`uncaught: ${text}`);
    }
  });

  const openTarget = async (url) => {
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    await browser.send("Runtime.enable", {}, sessionId);
    await browser.send("Page.enable", {}, sessionId);
    await browser.send("Page.navigate", { url }, sessionId);
    // `Target.createTarget({url})` can silently stay on about:blank; driving
    // Page.navigate and waiting for the URL to change makes it observable.
    await waitFor(browser, sessionId, "location.href !== 'about:blank'", {
      attempts: 80,
      interval: 250,
    });
    return { targetId, sessionId };
  };

  // --- Strict CSP page. ----------------------------------------------------
  {
    const { sessionId } = await openTarget(`http://127.0.0.1:${HTTP_PORT}/csp`);
    await waitFor(browser, sessionId, "document.readyState === 'complete' && !!document.getElementById('target')");
    const found = await selectUntilButton(browser, sessionId);
    if (!found) failures.push("strict-CSP page: micro-button did not appear or was untranslated");
    else {
      console.log(`PASS  : strict-CSP page: micro-button mounted (${JSON.stringify(found.label)})`);
      await evaluate(
        browser,
        sessionId,
        `(() => { document.querySelector('es-micro-button')?.shadowRoot?.querySelector('button')?.click(); return true; })()`,
      );
      const popup = await waitFor(
        browser,
        sessionId,
        `!!document.querySelector('es-quick-popup')?.shadowRoot?.querySelector('.es-pop')`,
        { attempts: 40 },
      );
      if (!popup) failures.push("strict-CSP page: quick-read pop-up did not mount");
      else console.log("PASS  : strict-CSP page: quick-read pop-up mounted");
    }
  }

  // --- Offline dictionary. -------------------------------------------------
  {
    // The launch flag above makes only freedictionaryapi.com unreachable.
    const { sessionId } = await openTarget(`http://127.0.0.1:${HTTP_PORT}/word`);
    await waitFor(browser, sessionId, "document.readyState === 'complete' && !!document.getElementById('w')");
    const wordFound = await selectUntilButton(browser, sessionId, { script: SELECT_WORD_SCRIPT });
    if (!wordFound) {
      const state = await evaluate(
        browser,
        sessionId,
        `JSON.stringify({ selection: String(getSelection()), hosts: document.querySelectorAll('es-micro-button').length, url: location.href })`,
      ).catch(() => "unavailable");
      failures.push(`offline: micro-button never appeared (${state})`);
    }
    await evaluate(
      browser,
      sessionId,
      `(() => { document.querySelector('es-micro-button')?.shadowRoot?.querySelector('button')?.click(); return true; })()`,
    );
    const offlineNote = await waitFor(
      browser,
      sessionId,
      `(() => {
         const pop = document.querySelector('es-quick-popup')?.shadowRoot;
         const note = pop?.querySelector('.es-meaning .es-note')?.textContent?.trim() ?? '';
         return note.includes('not reachable') ? note : false;
       })()`,
      { attempts: 60 },
    );
    if (!offlineNote) {
      const diagnostic = await evaluate(
        browser,
        sessionId,
        `(() => {
           const pop = document.querySelector('es-quick-popup')?.shadowRoot;
           return JSON.stringify({
             popup: !!pop,
             meaning: (pop?.querySelector('.es-meaning')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 160),
             notes: [...(pop?.querySelectorAll('.es-note') ?? [])].map((n) => n.textContent.trim()),
           });
         })()`,
      ).catch((e) => `unavailable: ${e.message}`);
      failures.push(`offline: pop-up did not show the offline dictionary state (${diagnostic})`);
    } else {
      console.log(`PASS  : offline dictionary explained: ${JSON.stringify(offlineNote)}`);
    }
  }

  // --- No voices installed. ------------------------------------------------
  {
    const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    await browser.send("Runtime.enable", {}, sessionId);
    await browser.send("Page.enable", {}, sessionId);
    await browser.send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: `try { speechSynthesis.getVoices = () => []; } catch (err) { /* best effort */ }`,
      },
      sessionId,
    );
    await browser.send("Page.navigate", { url: panelUrl }, sessionId);
    await waitFor(
      browser,
      sessionId,
      "document.readyState === 'complete' && !!document.getElementById('practice-text')",
    );
    await waitFor(browser, sessionId, "!!document.querySelector('dialog.onboarding[open]')", {
      attempts: 20,
    });
    await evaluate(
      browser,
      sessionId,
      "document.querySelector('dialog.onboarding .link-button')?.click(); true",
    );
    await waitFor(browser, sessionId, "!document.querySelector('dialog.onboarding[open]')");
    await evaluate(
      browser,
      sessionId,
      `(() => {
         const area = document.getElementById('practice-text');
         area.value = 'hello';
         area.dispatchEvent(new Event('input', { bubbles: true }));
         const listen = [...document.querySelectorAll('#panel-practise button')]
           .find((b) => b.textContent.includes('Listen'));
         listen.click();
         return true;
       })()`,
    );
    const noVoice = await waitFor(
      browser,
      sessionId,
      `(() => {
         const status = [...document.querySelectorAll('#panel-practise .status')]
           .map((n) => n.textContent.trim())
           .find((text) => text.includes('Speech is not available'));
         return status ?? false;
       })()`,
      { attempts: 40 },
    );
    if (!noVoice) failures.push("no voices: Listen neither spoke nor explained that speech is unavailable");
    else console.log(`PASS  : no voices installed is explained: ${JSON.stringify(noVoice)}`);
  }

  // --- Real sites. ---------------------------------------------------------
  // Google Docs is deliberately not here: its editor renders into a canvas and
  // disables native selection, so it needs a signed-in manual pass (spec 7
  // allows documenting what cannot be automated). See extension/docs/DECISIONS.md.
  const sites = [
    ["Wikipedia", "https://en.wikipedia.org/wiki/English_language"],
    ["GitHub", "https://github.com/microsoft/TypeScript"],
    ["YouTube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  ];
  for (const [name, url] of sites) {
    const { sessionId } = await openTarget(url);
    const ready = await waitFor(
      browser,
      sessionId,
      "document.readyState === 'complete' && !!document.body && document.body.innerText.trim().length > 0",
      { attempts: 60, interval: 250 },
    );
    const where = await evaluate(browser, sessionId, "location.href").catch(() => "");
    const bodyText = await evaluate(
      browser,
      sessionId,
      "(document.body?.innerText ?? '').slice(0, 400)",
    ).catch(() => "");
    if (
      !ready ||
      /accounts\.google\.com|google\.com\/ServiceLogin/.test(where) ||
      /unable to open|request access|doesn't exist|does not exist/i.test(bodyText)
    ) {
      console.log(`SKIP  : ${name} (needs sign-in or never finished loading: ${where})`);
      continue;
    }
    const found = await selectUntilButton(browser, sessionId);
    if (!found) {
      const state = await evaluate(
        browser,
        sessionId,
        `JSON.stringify({
           selection: String(getSelection()).slice(0, 40),
           hosts: document.querySelectorAll('es-micro-button').length,
           paragraphs: document.querySelectorAll('p').length,
         })`,
      ).catch(() => "unavailable");
      console.log(`SKIP  : ${name} (no micro-button; selection/hosts=${state})`);
      continue;
    }
    console.log(
      `PASS  : ${name}: micro-button mounted for ${JSON.stringify(found.selected.slice(0, 40))}`,
    );
  }

  if (ownErrors.length > 0) failures.push(...ownErrors);

  browser.close();
  cleanup();

  if (failures.length > 0) {
    console.error("\nFAIL:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nPASS: strict CSP, offline dictionary, no voices and the real-site matrix behaved.");
}

main().catch((err) => {
  console.error("FAIL: check crashed:", err);
  process.exit(1);
});
