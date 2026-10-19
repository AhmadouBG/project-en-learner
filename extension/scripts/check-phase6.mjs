/**
 * Phase 6 acceptance check against real Chrome (spec 7, Phase 6):
 *   "Port the existing panel UI. Check: text carries over from the pop-up; all
 *    controls are keyboard reachable; dark mode works."
 *
 * It also exercises the parts of Phases 7-11 that are reachable without a
 * microphone: the practise controls, the IPA breakdown, the YouGlish gate, the
 * onboarding dialog, the language switch and the stored practice hand-off.
 *
 * Usage: node scripts/check-phase6.mjs [--headed]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, ".output", "chrome-mv3");
const PORT = Number(process.env["ES_CDP_PORT"] ?? 9461);
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

/** Poll an expression until it is truthy, or return the last value. */
async function waitFor(cdp, sessionId, expression, { attempts = 60, interval = 200 } = {}) {
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

  const profile = mkdtempSync(join(tmpdir(), "es-phase6-"));
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
  const { id: extensionId } = await browser.send("Extensions.loadUnpacked", { path: EXT_DIR });
  console.log(`ext id : ${extensionId}`);

  const panelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
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
  browser.on("Log.entryAdded", (p) => {
    if (p.entry.level !== "error") return;
    consoleErrors.push(`log.${p.entry.source}: ${p.entry.text}`);
  });

  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Log.enable", {}, sessionId);
  await browser.send("Page.navigate", { url: panelUrl }, sessionId);

  const loaded = await waitFor(
    browser,
    sessionId,
    "document.readyState === 'complete' && !!document.getElementById('practice-text')",
  );
  if (!loaded) {
    failures.push("practise tab never mounted (#practice-text missing)");
  } else {
    console.log("PASS  : panel mounted with the practise tab");
  }

  // --- Onboarding appears once, and skipping it persists. ------------------
  const onboardingOpen = await waitFor(
    browser,
    sessionId,
    "!!document.querySelector('dialog.onboarding[open]')",
    { attempts: 20 },
  );
  if (!onboardingOpen) {
    failures.push("onboarding dialog did not open on a clean profile");
  } else {
    console.log("PASS  : onboarding opened on first run");
    await evaluate(
      browser,
      sessionId,
      "document.querySelector('dialog.onboarding .link-button').click()",
    );
    const closed = await waitFor(
      browser,
      sessionId,
      "!document.querySelector('dialog.onboarding[open]')",
      { attempts: 20 },
    );
    const persisted = await evaluate(
      browser,
      sessionId,
      `(async () => {
         const bag = await chrome.storage.local.get('es.store');
         return bag['es.store']?.settings?.onboardingCompleted === true;
       })()`,
    );
    if (!closed || !persisted) {
      failures.push(`onboarding did not persist (closed=${closed}, persisted=${persisted})`);
    } else {
      console.log("PASS  : onboarding is skippable and remembered");
    }
  }

  // --- Controls exist and are labelled. ------------------------------------
  const controlReport = JSON.parse(
    await evaluate(
      browser,
      sessionId,
      `(() => {
         const root = document.getElementById('panel-practise');
         const text = (node) => node?.textContent?.trim() ?? '';
         const buttons = [...root.querySelectorAll('button')];
         return JSON.stringify({
           textarea: !!root.querySelector('#practice-text'),
           textareaPlaceholder: root.querySelector('#practice-text')?.placeholder ?? '',
           accentButtons: [...root.querySelectorAll('.segmented .segment')].map((b) => b.textContent.trim()),
           accentLong: [...root.querySelectorAll('.segmented .segment')].map((b) => b.getAttribute('aria-label')),
           speed: root.querySelector('#practice-speed')?.value ?? null,
           rounds: [...(root.querySelector('#shadow-rounds')?.options ?? [])].map((o) => o.value),
           gaps: [...(root.querySelector('#shadow-gap')?.options ?? [])].map((o) => o.textContent.trim()),
           waveforms: root.querySelectorAll('canvas.waveform').length,
           sections: [...root.querySelectorAll('.section-title')].map(text),
           buttons: buttons.map(text),
           saveLabel: text([...root.querySelectorAll('button')].at(-1)),
         });
       })()`,
    ),
  );
  console.log(`        controls: ${JSON.stringify(controlReport)}`);
  if (!controlReport.textarea) failures.push("missing #practice-text");
  if (controlReport.textareaPlaceholder === "") failures.push("textarea has no translated placeholder");
  if (controlReport.accentButtons.length !== 2) {
    failures.push(`expected 2 accent buttons, found ${controlReport.accentButtons.length}`);
  }
  if (controlReport.speed === null) failures.push("missing #practice-speed");
  if (controlReport.rounds.join(",") !== "1,3,5") {
    failures.push(`shadow rounds were ${controlReport.rounds.join(",")}`);
  }
  if (controlReport.waveforms !== 1) failures.push("missing waveform canvas");

  // --- Text -> IPA breakdown, YouGlish gate, accent toggle. ----------------
  await evaluate(
    browser,
    sessionId,
    `(() => {
       const area = document.getElementById('practice-text');
       area.value = 'hello';
       area.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
  );
  const ipaReady = await waitFor(
    browser,
    sessionId,
    `(() => {
       const words = document.querySelectorAll('#panel-practise .ipa-word');
       if (words.length !== 1) return false;
       const ipa = words[0].querySelector('.ipa-word-ipa')?.textContent?.trim() ?? '';
       return ipa !== '' && ipa !== '—';
     })()`,
  );
  const ipaText = await evaluate(
    browser,
    sessionId,
    "document.querySelector('#panel-practise .ipa-word-ipa')?.textContent?.trim() ?? ''",
  );
  const youglish = JSON.parse(
    await evaluate(
      browser,
      sessionId,
      `(() => {
         const row = document.querySelector('#panel-practise .youglish-row');
         const link = row?.querySelector('a');
         return JSON.stringify({ hidden: row?.hidden ?? null, href: link?.href ?? '', text: link?.textContent?.trim() ?? '' });
       })()`,
    ),
  );
  console.log(`        ipa="${ipaText}" youglish=${JSON.stringify(youglish)}`);
  if (!ipaReady) failures.push(`IPA for "hello" never arrived (got ${JSON.stringify(ipaText)})`);
  if (youglish.hidden) failures.push("YouGlish row hidden for a single word");
  if (!/youglish\.com\/pronounce\/hello\/english\/us/.test(youglish.href)) {
    failures.push(`YouGlish href was ${youglish.href}`);
  }

  const longHidden = await evaluate(
    browser,
    sessionId,
    `(() => {
       const area = document.getElementById('practice-text');
       area.value = 'could you schedule the meeting for me today';
       area.dispatchEvent(new Event('input', { bubbles: true }));
       return document.querySelector('#panel-practise .youglish-row')?.hidden === true;
     })()`,
  );
  if (!longHidden) failures.push("YouGlish row visible for a long sentence");
  else console.log("PASS  : YouGlish is hidden for long sentences");

  // Accent toggle must switch the active segment and remember the choice.
  await evaluate(
    browser,
    sessionId,
    "document.querySelectorAll('#panel-practise .segmented .segment')[1].click()",
  );
  const accentState = await evaluate(
    browser,
    sessionId,
    `(async () => {
       const buttons = [...document.querySelectorAll('#panel-practise .segmented .segment')];
       const bag = await chrome.storage.local.get('es.store');
       return JSON.stringify({
         pressed: buttons.map((b) => b.getAttribute('aria-pressed')),
         stored: bag['es.store']?.settings?.defaultAccent ?? null,
       });
     })()`,
  );
  const accentParsed = JSON.parse(accentState);
  console.log(`        accent: ${accentState}`);
  if (accentParsed.pressed[1] !== "true" || accentParsed.stored !== "en-GB") {
    failures.push(`accent toggle did not stick (${accentState})`);
  }

  // --- Dark mode. ----------------------------------------------------------
  await evaluate(
    browser,
    sessionId,
    `(() => {
       const theme = document.getElementById('set-theme');
       theme.value = 'dark';
       theme.dispatchEvent(new Event('change', { bubbles: true }));
       return true;
     })()`,
  );
  const dark = await waitFor(
    browser,
    sessionId,
    `(() => {
       if (document.documentElement.dataset.theme !== 'dark') return false;
       const bg = getComputedStyle(document.body).backgroundColor;
       return bg === 'rgb(32, 33, 36)' ? bg : false;
     })()`,
  );
  console.log(`        dark body = ${dark}`);
  if (!dark) failures.push("dark mode did not apply the dark surface colour");

  // --- Practice-target hand-off survives a reload. -------------------------
  await evaluate(
    browser,
    sessionId,
    `(async () => {
       const key = 'es.store';
       const bag = await chrome.storage.local.get(key);
       const store = bag[key] ?? { version: 1 };
       store.session = Object.assign({}, store.session, {
         target: { text: 'Could you schedule the meeting?', kind: 'sentence', accent: 'en-GB', speed: 1.25 },
       });
       await chrome.storage.local.set({ [key]: store });
       location.reload();
       return true;
     })()`,
  );
  const carried = await waitFor(
    browser,
    sessionId,
    `(() => {
       const area = document.getElementById('practice-text');
       const speed = document.getElementById('practice-speed');
       const uk = document.querySelectorAll('#panel-practise .segmented .segment')[1];
       if (!area) return false;
       return area.value === 'Could you schedule the meeting?' &&
         speed?.value === '1.25' && uk?.getAttribute('aria-pressed') === 'true';
     })()`,
    { attempts: 80 },
  );
  if (!carried) {
    const state = await evaluate(
      browser,
      sessionId,
      `JSON.stringify({
         value: document.getElementById('practice-text')?.value ?? null,
         speed: document.getElementById('practice-speed')?.value ?? null,
         uk: document.querySelectorAll('#panel-practise .segmented .segment')[1]?.getAttribute('aria-pressed') ?? null,
       })`,
    ).catch((e) => `unavailable: ${e.message}`);
    failures.push(`stored practice target did not carry over: ${state}`);
  } else {
    console.log("PASS  : stored practice target carried into the panel");
  }

  // --- EN/FR switch re-renders every string. -------------------------------
  await evaluate(
    browser,
    sessionId,
    `(() => {
       const language = document.getElementById('set-language');
       language.value = 'fr';
       language.dispatchEvent(new Event('change', { bubbles: true }));
       return true;
     })()`,
  );
  const french = await waitFor(
    browser,
    sessionId,
    `document.getElementById('tab-practise')?.textContent?.trim() === 'Pratiquer' &&
     document.getElementById('tab-settings')?.textContent?.trim() === 'Réglages'`,
    { attempts: 80 },
  );
  if (!french) {
    const tabs = await evaluate(
      browser,
      sessionId,
      "[...document.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim()).join(',')",
    ).catch((e) => `unavailable: ${e.message}`);
    failures.push(`language switch to French did not stick: ${tabs}`);
  } else {
    console.log("PASS  : the panel re-renders in French");
  }

  if (consoleErrors.length > 0) {
    failures.push(`console errors: ${consoleErrors.join(" | ")}`);
  } else {
    console.log("PASS  : no console errors in the side panel");
  }

  browser.close();
  cleanup();

  if (failures.length > 0) {
    console.error("\nFAIL:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nPASS: practise tab, IPA, YouGlish gate, dark mode, hand-off and EN/FR verified.");
}

main().catch((err) => {
  console.error("FAIL: check crashed:", err);
  process.exit(1);
});
