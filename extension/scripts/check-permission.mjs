/**
 * Phase 7 permission-recovery check against real Chrome.
 *
 * Spec 5.5: when the microphone prompt is dismissed or blocked in the side
 * panel, permission.html exists to request access from a normal tab. This check
 * runs with a media device present but permission blocked, so the panel must
 * show the denied row and its "Allow microphone" link must open the helper page.
 *
 * Usage: node scripts/check-permission.mjs [--headed]
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, ".output", "chrome-mv3");
const PORT = Number(process.env["ES_CDP_PORT"] ?? 9491);
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

async function waitFor(cdp, sessionId, expression, { attempts = 60, interval = 200 } = {}) {
  let value = false;
  for (let i = 0; i < attempts; i += 1) {
    value = await evaluate(cdp, sessionId, expression).catch(() => false);
    if (value) return value;
    await sleep(interval);
  }
  return value;
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

  const profile = mkdtempSync(join(tmpdir(), "es-permission-"));
  const args = [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    // A fake device, but no fake permission UI: getUserMedia is denied.
    "--use-fake-device-for-media-stream",
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
  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Page.enable", {}, sessionId);
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
       return true;
     })()`,
  );
  await waitFor(
    browser,
    sessionId,
    "document.querySelectorAll('#panel-practise .ipa-word').length === 1",
  );
  await evaluate(
    browser,
    sessionId,
    `(() => {
       const record = [...document.querySelectorAll('#panel-practise button')]
         .find((b) => b.textContent.includes('Record'));
       record.click();
       return true;
     })()`,
  );

  const denied = await waitFor(
    browser,
    sessionId,
    `(() => {
       const status = [...document.querySelectorAll('#panel-practise .status')]
         .map((n) => n.textContent.trim()).join(' | ');
       const helper = [...document.querySelectorAll('#panel-practise button')]
         .find((b) => b.textContent.includes('Allow microphone'));
       return status.includes('Microphone blocked') && helper && !helper.hidden ? status : false;
     })()`,
    { attempts: 60 },
  );
  if (!denied) {
    const state = await evaluate(
      browser,
      sessionId,
      `JSON.stringify({
         status: [...document.querySelectorAll('#panel-practise .status')].map((n) => n.textContent.trim()),
         buttons: [...document.querySelectorAll('#panel-practise button')].map((b) => ({ text: b.textContent.trim(), hidden: b.hidden })),
       })`,
    ).catch((e) => `unavailable: ${e.message}`);
    failures.push(`denied microphone was not surfaced in the panel: ${state}`);
  } else {
    console.log(`PASS  : blocked microphone shows the recovery row (${denied.split(" | ")[0]})`);
  }

  // The recovery link must open permission.html in a new tab.
  await evaluate(
    browser,
    sessionId,
    `(() => {
       const helper = [...document.querySelectorAll('#panel-practise button')]
         .find((b) => b.textContent.includes('Allow microphone'));
       helper.click();
       return true;
     })()`,
  );

  let permissionTarget = null;
  for (let i = 0; i < 40 && !permissionTarget; i += 1) {
    await sleep(250);
    const { targetInfos } = await browser.send("Target.getTargets");
    permissionTarget = targetInfos.find((t) => t.url.endsWith("/permission.html")) ?? null;
  }
  if (!permissionTarget) {
    failures.push("the Allow-microphone link did not open permission.html");
  } else {
    console.log(`PASS  : permission.html opened (${permissionTarget.url.split("/").pop()})`);
    const attached = await browser.send("Target.attachToTarget", {
      targetId: permissionTarget.targetId,
      flatten: true,
    });
    const permissionSession = attached.sessionId;
    await browser.send("Runtime.enable", {}, permissionSession);
    await waitFor(
      browser,
      permissionSession,
      "document.readyState === 'complete' && !!document.getElementById('permission-allow')",
    );
    const heading = await evaluate(
      browser,
      permissionSession,
      "document.getElementById('permission-title')?.textContent?.trim() ?? ''",
    );
    if (heading !== "Microphone access") failures.push(`permission page heading was ${heading}`);
    else console.log("PASS  : permission page shows translated copy");

    await evaluate(
      browser,
      permissionSession,
      "document.getElementById('permission-allow').click(); true",
    );
    const permissionDenied = await waitFor(
      browser,
      permissionSession,
      `(() => {
         const status = document.getElementById('permission-status')?.textContent ?? '';
         return status.includes('denied') ? status : false;
       })()`,
      { attempts: 60 },
    );
    if (!permissionDenied) failures.push("permission page did not report the denied result");
    else console.log("PASS  : permission page reports the browser-denied result");
  }

  browser.close();
  cleanup();

  if (failures.length > 0) {
    console.error("\nFAIL:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nPASS: denied microphone is explained and the helper page opens.");
}

main().catch((err) => {
  console.error("FAIL: check crashed:", err);
  process.exit(1);
});
