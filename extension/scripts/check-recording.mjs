/**
 * Phase 7/9/10 acceptance check against real Chrome.
 *
 * Phases 7 and 9 are the ones that cannot be unit-tested end to end: "first-time
 * permission prompt, denied state, helper-page recovery, level meter, waveform,
 * auto-stop on silence, playback and A/B" and "3-round loop completes, cancel
 * works at every state, no overlapping audio, no stuck microphone indicator".
 *
 * Chrome's fake media device lets us drive a real getUserMedia + MediaRecorder
 * path in headless mode. Word recognition cannot be made deterministic without
 * real speech, so this check asserts the *unsupported / no-speech* branch is
 * handled gracefully, while the alignment itself is covered by unit tests.
 *
 * Usage: node scripts/check-recording.mjs [--headed]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, ".output", "chrome-mv3");
const PORT = Number(process.env["ES_CDP_PORT"] ?? 9481);
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

const IMPORT_ITEM = {
  id: "import-1",
  text: "schedule",
  kind: "word",
  ipa: "ˈskɛdʒʊl",
  accent: "en-US",
  createdAt: 1,
  attempts: 0,
  lastResult: null,
  box: 1,
};

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

  const profile = mkdtempSync(join(tmpdir(), "es-recording-"));
  const args = [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=900,900",
    // A deterministic microphone: no prompt, no real hardware.
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "about:blank",
  ];
  if (HEADED) args.splice(args.indexOf("--headless=new"), 1);

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

  const mounted = await waitFor(
    browser,
    sessionId,
    "document.readyState === 'complete' && !!document.getElementById('practice-text')",
  );
  if (!mounted) {
    failures.push("panel never mounted");
  } else {
    console.log("PASS  : panel mounted");
  }
  await waitFor(browser, sessionId, "!!document.querySelector('dialog.onboarding[open]')", {
    attempts: 20,
  });
  await evaluate(
    browser,
    sessionId,
    "document.querySelector('dialog.onboarding .link-button')?.click(); true",
  );
  await waitFor(browser, sessionId, "!document.querySelector('dialog.onboarding[open]')");

  // --- Phase 7: record a take with the fake microphone. --------------------
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
  await waitFor(
    browser,
    sessionId,
    "document.querySelectorAll('#panel-practise .ipa-word').length === 1",
  );

  const started = await evaluate(
    browser,
    sessionId,
    `(() => {
       const record = [...document.querySelectorAll('#panel-practise button')]
         .find((b) => b.textContent.includes('Record'));
       record.click();
       return true;
     })()`,
  );
  if (!started) failures.push("could not click Record");

  const recording = await waitFor(
    browser,
    sessionId,
    `(() => {
       const button = document.querySelector('#panel-practise button.danger');
       const status = [...document.querySelectorAll('#panel-practise .status')]
         .map((n) => n.textContent.trim()).join(' | ');
       return button?.textContent.includes('Stop recording')
         ? { ok: true }
         : /denied|microphone|unavailable|failed/i.test(status)
           ? { ok: false, status }
           : false;
     })()`,
    { attempts: 50 },
  );
  if (!recording || recording.ok !== true) {
    failures.push(`recording never started: ${JSON.stringify(recording)}`);
  } else {
    console.log("PASS  : fake microphone opened and recording started");
  }

  await sleep(1_200);
  await evaluate(
    browser,
    sessionId,
    `(() => {
       const button = document.querySelector('#panel-practise button.danger');
       if (button?.textContent.includes('Stop recording')) button.click();
       return true;
     })()`,
  );

  const takeReady = await waitFor(
    browser,
    sessionId,
    `(() => {
       const play = [...document.querySelectorAll('#panel-practise button')]
         .find((b) => b.textContent.includes('Play my take'));
       const result = document.querySelector('#panel-practise .result-body')?.textContent?.trim() ?? '';
       return play && !play.disabled && result !== '' ? result : false;
     })()`,
    { attempts: 80 },
  );
  if (!takeReady) {
    failures.push("take never completed (Play my take stayed disabled)");
  } else {
    console.log(`PASS  : take completed; result block = ${JSON.stringify(takeReady.slice(0, 120))}`);
  }

  // Auto-save is on by default, so "hello" should have been stored.
  const stored = await waitFor(
    browser,
    sessionId,
    `(async () => {
       const bag = await chrome.storage.local.get('es.store');
       const saved = bag['es.store']?.saved ?? [];
       return saved.length === 1 && saved[0].text === 'hello';
     })()`,
    { attempts: 40 },
  );
  if (!stored) failures.push("the first recording was not auto-saved");
  else console.log("PASS  : first take auto-saved to the saved list");

  // --- Phase 10: persistence across a reload. ------------------------------
  await evaluate(browser, sessionId, "location.reload(); true");
  await waitFor(
    browser,
    sessionId,
    "document.readyState === 'complete' && !!document.getElementById('tab-saved')",
    { attempts: 80 },
  );
  await evaluate(browser, sessionId, "document.getElementById('tab-saved').click(); true");
  const listed = await waitFor(
    browser,
    sessionId,
    `(() => {
       const cards = document.querySelectorAll('#panel-saved .saved-card');
       return cards.length === 1 && cards[0].textContent.includes('hello');
     })()`,
  );
  if (!listed) failures.push("saved item did not survive a panel reload");
  else console.log("PASS  : saved items survive a reload (chrome.storage.local)");

  // Search filters, then clears.
  await evaluate(
    browser,
    sessionId,
    `(() => {
       const search = document.getElementById('saved-search');
       search.value = 'zzz-nope';
       search.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
  );
  const filtered = await waitFor(
    browser,
    sessionId,
    `document.querySelectorAll('#panel-saved .saved-card').length === 0`,
  );
  await evaluate(
    browser,
    sessionId,
    `(() => {
       const search = document.getElementById('saved-search');
       search.value = '';
       search.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
  );
  const restored = await waitFor(
    browser,
    sessionId,
    `document.querySelectorAll('#panel-saved .saved-card').length === 1`,
  );
  if (!filtered || !restored) failures.push("saved search did not filter and clear");
  else console.log("PASS  : saved search filters and clears");

  // Review card: flip, grade Good, box advances to 2.
  await evaluate(
    browser,
    sessionId,
    `(() => {
       const review = [...document.querySelectorAll('#panel-saved button')]
         .find((b) => b.textContent.includes('Review'));
       review.click();
       return true;
     })()`,
  );
  const card = await waitFor(
    browser,
    sessionId,
    "!!document.querySelector('#panel-saved .review-card')",
  );
  await evaluate(
    browser,
    sessionId,
    `(() => {
       const flip = [...document.querySelectorAll('#panel-saved .review-card button')]
         .find((b) => b.textContent.includes('Flip'));
       flip.click();
       return true;
     })()`,
  );
  const graded = await waitFor(
    browser,
    sessionId,
    `(() => {
       const good = [...document.querySelectorAll('#panel-saved .review-card button')]
         .find((b) => b.textContent.trim() === 'Good');
       if (!good) return false;
       good.click();
       return true;
     })()`,
  );
  const boxed = await waitFor(
    browser,
    sessionId,
    `(async () => {
       const bag = await chrome.storage.local.get('es.store');
       return bag['es.store']?.saved?.[0]?.box === 2;
     })()`,
    { attempts: 40 },
  );
  if (!card || !graded || !boxed) {
    failures.push(`review flow did not grade the card (card=${card}, graded=${graded}, box=${boxed})`);
  } else {
    console.log("PASS  : review card flips and Good advances the box to 2");
  }

  // Import: a valid file merges, an invalid one is rejected with a message.
  const imported = await evaluate(
    browser,
    sessionId,
    `(async () => {
       const input = document.querySelector('#panel-saved input[type=file]');
       const payload = ${JSON.stringify(JSON.stringify({ version: 1, exportedAt: 0, items: [IMPORT_ITEM] }))};
       const transfer = new DataTransfer();
       transfer.items.add(new File([payload], 'import.json', { type: 'application/json' }));
       input.files = transfer.files;
       input.dispatchEvent(new Event('change', { bubbles: true }));
       return true;
     })()`,
  );
  const mergedCount = await waitFor(
    browser,
    sessionId,
    `document.querySelectorAll('#panel-saved .saved-card').length === 2`,
    { attempts: 40 },
  );
  const invalid = await evaluate(
    browser,
    sessionId,
    `(() => {
       const input = document.querySelector('#panel-saved input[type=file]');
       const transfer = new DataTransfer();
       transfer.items.add(new File(['{not json'], 'bad.json', { type: 'application/json' }));
       input.files = transfer.files;
       input.dispatchEvent(new Event('change', { bubbles: true }));
       return true;
     })()`,
  );
  const rejected = await waitFor(
    browser,
    sessionId,
    `(() => {
       const toast = document.querySelector('.toast');
       return toast?.textContent.includes('not a valid saved-items export') ?? false;
     })()`,
    { attempts: 30 },
  );
  const stillTwo = await evaluate(
    browser,
    sessionId,
    "document.querySelectorAll('#panel-saved .saved-card').length === 2",
  );
  if (!imported || !mergedCount) failures.push("valid import did not merge into the list");
  if (!invalid || !rejected) failures.push("invalid import was not rejected with a message");
  if (!stillTwo) failures.push("invalid import changed the saved list");
  if (imported && mergedCount && rejected && stillTwo) {
    console.log("PASS  : import merges valid files and rejects invalid ones");
  }

  // --- Phase 9: start the shadow loop, then cancel it. ---------------------
  await evaluate(browser, sessionId, "document.getElementById('tab-practise').click(); true");
  await evaluate(
    browser,
    sessionId,
    `(() => {
       const area = document.getElementById('practice-text');
       area.value = 'hello';
       area.dispatchEvent(new Event('input', { bubbles: true }));
       const rounds = document.getElementById('shadow-rounds');
       rounds.value = '1';
       rounds.dispatchEvent(new Event('change', { bubbles: true }));
       return true;
     })()`,
  );
  await evaluate(
    browser,
    sessionId,
    `(() => {
       const start = [...document.querySelectorAll('#panel-practise button')]
         .find((b) => b.textContent.includes('Start shadowing'));
       start.click();
       return true;
     })()`,
  );
  const loopRunning = await waitFor(
    browser,
    sessionId,
    `(() => {
       const status = [...document.querySelectorAll('#panel-practise .status')]
         .map((n) => n.textContent.trim())
         .find((text) => text.includes('Round 1 of 1'));
       const cancel = [...document.querySelectorAll('#panel-practise button')]
         .find((b) => b.textContent.includes('Cancel shadowing'));
       return status !== undefined && cancel && !cancel.hidden ? status : false;
     })()`,
    { attempts: 50 },
  );
  if (!loopRunning) {
    failures.push("shadow loop never entered the playing state");
  } else {
    console.log(`PASS  : shadow loop started (${loopRunning})`);
  }

  await evaluate(
    browser,
    sessionId,
    `(() => {
       const cancel = [...document.querySelectorAll('#panel-practise button')]
         .find((b) => b.textContent.includes('Cancel shadowing'));
       if (cancel && !cancel.hidden) cancel.click();
       return true;
     })()`,
  );
  const cancelled = await waitFor(
    browser,
    sessionId,
    `(() => {
       const cancel = [...document.querySelectorAll('#panel-practise button')]
         .find((b) => b.textContent.includes('Cancel shadowing'));
       const start = [...document.querySelectorAll('#panel-practise button')]
         .find((b) => b.textContent.includes('Start shadowing'));
       return cancel?.hidden === true && start && !start.disabled;
     })()`,
    { attempts: 40 },
  );
  if (!cancelled) failures.push("shadow loop did not cancel cleanly");
  else console.log("PASS  : shadow loop cancels and re-enables Start");

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
  console.log("\nPASS: recording, auto-save, saved/review/import and shadow cancel verified.");
}

main().catch((err) => {
  console.error("FAIL: check crashed:", err);
  process.exit(1);
});
