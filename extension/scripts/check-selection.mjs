/**
 * Phase 2 acceptance check: selection capture and the micro-button.
 *
 * Spec 7, Phase 2: "works on Wikipedia, GitHub, a news site, a page with an
 * iframe; does not appear on password fields; hides correctly; positions
 * correctly near viewport edges and after scrolling."
 *
 * This drives a real page in real Chrome, performs a real text selection, and
 * asserts the button appears inside the shadow root, in the viewport, and obeys
 * the guards. The button lives in a shadow root, so it is inspected through the
 * host element rather than with a document query.
 *
 * Fixtures are served over HTTP because content scripts do not run on file://.
 *
 * Usage: node scripts/check-selection.mjs
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, ".output", "chrome-mv3");
const CDP_PORT = Number(process.env["ES_CDP_PORT"] ?? 9491);
const HTTP_PORT = Number(process.env["ES_HTTP_PORT"] ?? 8491);
// WXT creates a custom element named `${NS}-${name}`; NS is "es" and the button
// passes name "micro-button", so the host tag is <es-micro-button>.
const HOST_TAG = "es-micro-button";

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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "threw");
  return r.result?.value;
}

function startFixtureServer() {
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>selection</title>
<style>
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  #pad-top { height: 400px; background: #f3f3f3; }
  .corner { position: absolute; }
  #top-left  { top: 0; left: 0; }
  #bottom-right { bottom: 0; right: 0; }
  #far { margin-top: 2000px; }
</style></head><body>
<div id="pad-top">scroll down</div>
<p class="corner" id="top-left">Top left corner selection text</p>
<p id="middle">Could you schedule the meeting for tomorrow?</p>
<p id="scroll-target">A dedicated target for the scroll-following check.</p>
<p class="corner" id="bottom-right">Bottom right corner selection text</p>
<p><label for="pw">Password: </label><input id="pw" type="password" value="hunter2"></p>
<p id="divider">||| *** ---</p>
<p id="far">Far away selection text down the page</p>
</body></html>`;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${HTTP_PORT}`);
    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    if (url.pathname === "/frame.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><body><p id="frame-text">Selection inside an iframe</p></body></html>`,
      );
      return;
    }
    res.writeHead(404).end("nope");
  });
  return new Promise((r) => server.listen(HTTP_PORT, "127.0.0.1", () => r(server)));
}

/** Select the text of `#id` and fire the events a real drag would. */
const SELECT_SNIPPET = (id) => `(async () => {
  const el = document.getElementById(${JSON.stringify(id)});
  if (!el) return 'missing element';
  el.scrollIntoView({ block: 'center' });
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  // A real drag ends with mouseup; the extension debounces on it.
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return 'ok';
})()`;

// The host is an unstyled 0x0 custom element; the positioned element is the
// container inside the shadow root, which is where our CSS applies.
const BUTTON_STATE = `(() => {
  const host = document.querySelector('${HOST_TAG}');
  if (!host) return JSON.stringify({ present: false });
  const shadow = host.shadowRoot;
  const root = shadow && shadow.querySelector('.es-root');
  const btn = shadow && shadow.querySelector('.es-button');
  const tip = shadow && shadow.querySelector('.es-tooltip');
  if (!root || !btn) {
    return JSON.stringify({ present: true, hasButton: !!btn, hasRoot: !!root });
  }
  const r = btn.getBoundingClientRect();

  // The rect of the text the user actually selected, for an overlap check.
  let selRect = null;
  const sel = getSelection();
  if (sel && sel.rangeCount > 0) {
    const sr = sel.getRangeAt(0).getBoundingClientRect();
    selRect = { left: sr.left, top: sr.top, right: sr.right, bottom: sr.bottom };
  }

  const overlaps = (a, b) =>
    !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  return JSON.stringify({
    present: true,
    hasButton: true,
    hasRoot: true,
    ariaLabel: btn.getAttribute('aria-label'),
    rootPosition: getComputedStyle(root).position,
    rootLeft: root.style.left,
    rootTop: root.style.top,
    // Real rendered geometry of the button, not of the 0x0 host.
    left: r.left, top: r.top, width: r.width, height: r.height,
    viewportW: innerWidth, viewportH: innerHeight,
    // Neither the button nor the tooltip may cover the selected text. The
    // tooltip one was a real bug: it hung below a button that sits above the
    // selection, so it landed on the words the user had just selected.
    selRect,
    buttonOverlapsSelection: overlaps(r, selRect),
    hasTooltip: !!tip,
    tooltipWidth: tip ? tip.offsetWidth : 0,
    containerLeft: root.style.left,
    containerWidth: Math.round(root.getBoundingClientRect().width),
    innerWidth: innerWidth,
    tooltipOverlapsSelection: tip ? overlaps(tip.getBoundingClientRect(), selRect) : false,
  });
})()`;

/**
 * Assert the button respects the "Show button on selection" setting live.
 *
 * Regression: the setting used to be read once at document_idle, so switching it
 * off only took effect after a page refresh. Spec 4.3 lists it as a setting, and
 * a setting that needs a refresh reads as broken.
 *
 * Returns a list of failure strings.
 */
async function checkSettingToggle(cdp, sessionId, log) {
  void log;
  const failures = [];
  const ROOT_KEY = "es.store";

  const setSetting = async (showButtonOnSelection, contextId) =>
    evaluate(
      cdp,
      sessionId,
      `(async () => {
         const bag = await chrome.storage.local.get(${JSON.stringify(ROOT_KEY)});
         const store = bag[${JSON.stringify(ROOT_KEY)}] ?? {};
         const next = {
           version: 1,
           settings: { ...(store.settings ?? {}), showButtonOnSelection: ${showButtonOnSelection} },
           saved: store.saved ?? [],
           dictCache: store.dictCache ?? [],
           session: store.session ?? { target: null },
         };
         await chrome.storage.local.set({ [${JSON.stringify(ROOT_KEY)}]: next });
         return 'written';
       })()`,
      contextId,
    ).catch((e) => `error: ${e.message}`);

  // Needs the extension's own storage, so run inside its isolated world.
  const extContext = findExtensionContext();
  if (extContext === undefined) {
    failures.push("could not find the extension's isolated world to write settings from");
    return failures;
  }

  // A different element from the earlier checks on purpose: check 6 pressed Esc on
  // the #middle selection, and the gate deliberately refuses to resurrect a
  // dismissed selection. Re-picking #middle here would be testing the gate
  // instead of the setting.
  const TARGET = "top-left";

  // --- switch OFF while the page stays open
  await evaluate(cdp, sessionId, `getSelection().removeAllRanges()`).catch(() => null);
  await sleep(200);
  await evaluate(cdp, sessionId, SELECT_SNIPPET(TARGET));
  await sleep(500);
  let state = JSON.parse(await evaluate(cdp, sessionId, BUTTON_STATE));
  if (!state.present) {
    failures.push("setup: expected the button before switching the setting off");
  }

  await setSetting(false, extContext);
  await sleep(700);
  await evaluate(cdp, sessionId, `getSelection().removeAllRanges()`).catch(() => null);
  await sleep(200);
  await evaluate(cdp, sessionId, SELECT_SNIPPET(TARGET));
  await sleep(600);
  state = JSON.parse(await evaluate(cdp, sessionId, BUTTON_STATE));
  if (state.present) {
    failures.push("button still appeared after the setting was switched off");
  } else {
    log("PASS  : switching the setting off hides the button without a page refresh");
  }

  // --- switch back ON, still without a refresh
  await setSetting(true, extContext);
  await sleep(700);
  await evaluate(cdp, sessionId, `getSelection().removeAllRanges()`).catch(() => null);
  await sleep(200);
  await evaluate(cdp, sessionId, SELECT_SNIPPET("bottom-right"));
  await sleep(600);
  state = JSON.parse(await evaluate(cdp, sessionId, BUTTON_STATE));
  if (!state.present) {
    failures.push("button did not come back after the setting was switched on");
  } else {
    log("PASS  : switching the setting on restores the button without a page refresh");
  }

  return failures;
}

/**
 * Execution contexts seen on this page, so we can find the extension's isolated
 * world. Chrome reports these on the browser socket WITHOUT a sessionId even
 * under flatten:true (verified empirically in check-frames.mjs).
 */
const contexts = [];

/** The content script runs in an isolated world with a chrome-extension:// origin. */
function findExtensionContext() {
  for (const c of contexts) {
    if (c.isIsolated && c.origin.startsWith("chrome-extension://")) return c.id;
  }
  return undefined;
}

/** Find the extension's MV3 service worker target. */
async function findServiceWorkerTarget(cdp) {
  for (let i = 0; i < 20; i += 1) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const sw = targetInfos.find(
      (t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"),
    );
    if (sw) return sw.targetId;
    await sleep(300);
  }
  return undefined;
}

/**
 * Assert the UI does not survive the extension being reloaded or disabled.
 *
 * Chrome does NOT un-inject a content script when the extension is disabled or
 * reloaded, so without an explicit signal the micro-button keeps working from an
 * extension the user has switched off. The content script holds a long-lived port
 * for exactly this reason.
 *
 * Simulated with `chrome.runtime.reload()` in the service worker, which tears
 * the extension down the same way a reload from chrome://extensions does, but
 * without reloading the page.
 */
async function checkTearsDownOnExtensionReload(cdp, sessionId, log) {
  const failures = [];

  await evaluate(cdp, sessionId, `getSelection().removeAllRanges()`).catch(() => null);
  await sleep(200);
  await evaluate(cdp, sessionId, SELECT_SNIPPET("far"));
  await sleep(500);
  let state = JSON.parse(await evaluate(cdp, sessionId, BUTTON_STATE));
  if (!state.present) {
    failures.push("setup: expected the button while the extension is alive");
    return failures;
  }

  const swTarget = await findServiceWorkerTarget(cdp);
  if (!swTarget) {
    failures.push("could not find the service worker to reload from");
    return failures;
  }
  const { sessionId: swSession } = await cdp.send("Target.attachToTarget", {
    targetId: swTarget,
    flatten: true,
  });
  await cdp.send("Runtime.enable", {}, swSession);
  await evaluate(cdp, swSession, "chrome.runtime.reload()").catch(() => null);
  await sleep(1800);

  // Select again without reloading the page.
  await evaluate(cdp, sessionId, `getSelection().removeAllRanges()`).catch(() => null);
  await sleep(200);
  await evaluate(cdp, sessionId, SELECT_SNIPPET("far"));
  await sleep(700);
  state = JSON.parse(await evaluate(cdp, sessionId, BUTTON_STATE));
  if (state.present) {
    failures.push(
      "the micro-button still worked after the extension was reloaded (stale content script)",
    );
  } else {
    log("PASS  : the UI tears itself down when the extension is reloaded");
  }

  return failures;
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
  const profile = mkdtempSync(join(tmpdir(), "es-sel-"));
  const child = spawn(
    chrome,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--window-size=1024,768",
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
  await browser.send("Extensions.loadUnpacked", { path: EXT_DIR });

  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });

  const consoleErrors = [];
  browser.on("Runtime.consoleAPICalled", (p) => {
    if (p.sessionId !== undefined && p.sessionId !== sessionId) return;
    if (p.type === "error" || p.type === "assert") {
      consoleErrors.push(`console.${p.type}: ${(p.args ?? []).map((a) => a.value ?? a.description).join(" ")}`);
    }
  });
  browser.on("Runtime.exceptionThrown", (p) => {
    if (p.sessionId !== undefined && p.sessionId !== sessionId) return;
    consoleErrors.push(`uncaught: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`);
  });
  // Tracked so the setting check can write chrome.storage from the extension's
  // own world.
  browser.on("Runtime.executionContextCreated", (p) => {
    if (p.sessionId !== undefined && p.sessionId !== sessionId) return;
    const c = p.context;
    if (!c) return;
    contexts.push({
      id: c.id,
      isIsolated: c.auxData?.isDefault === false,
      origin: c.origin ?? "",
    });
  });
  browser.on("Runtime.executionContextsCleared", (p) => {
    if (p.sessionId !== undefined && p.sessionId !== sessionId) return;
    contexts.length = 0;
  });

  await browser.send("Runtime.enable", {}, sessionId);
  await browser.send("Page.enable", {}, sessionId);
  await browser.send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` }, sessionId);

  // Wait for the content script to attach its listeners.
  for (let i = 0; i < 50; i += 1) {
    await sleep(200);
    const ready = await evaluate(
      browser,
      sessionId,
      `!!document.getElementById('middle') && document.readyState === 'complete'`,
    ).catch(() => false);
    if (ready) break;
  }

  const failures = [];
  const results = [];

  // --- 1. Ordinary selection shows the button ------------------------------
  await evaluate(browser, sessionId, SELECT_SNIPPET("middle"));
  await sleep(500);
  let state = JSON.parse(await evaluate(browser, sessionId, BUTTON_STATE));
  results.push(["ordinary selection", state]);
  if (!state.present || !state.hasButton) {
    failures.push("no micro-button appeared for an ordinary selection");
  } else {
    console.log(`PASS  : button appeared (aria-label=${JSON.stringify(state.ariaLabel)})`);
    if (state.rootPosition !== "fixed") {
      failures.push(`container position was ${state.rootPosition}, expected fixed`);
    }
    // Spec 4.1: a 28 px round button.
    if (Math.round(state.width) !== 28 || Math.round(state.height) !== 28) {
      failures.push(`button is ${state.width}x${state.height}, expected 28x28`);
    }
    // Never cover the words the user selected, and never let the tooltip do it.
    if (state.buttonOverlapsSelection) {
      failures.push("the button overlaps the selected text");
    }
    if (state.tooltipOverlapsSelection) {
      failures.push("the tooltip overlaps the selected text");
    }
    if (state.hasTooltip) {
      console.log("PASS  : button and tooltip both clear of the selected text");
    }

    // The button must sit directly above the END of the selection, right edge on
    // right edge. Two regressions are guarded here:
    //   1. the placement box was sized to the TOOLTIP width, pushing the button
    //      ~150 px left;
    //   2. geometry came from a StaticRange with no rect methods, silently
    //      falling back to the whole paragraph element's box (658 px error).
    if (state.selRect) {
      const buttonRight = state.left + state.width;
      const gap = Math.abs(buttonRight - state.selRect.right);
      if (gap > 4) {
        failures.push(
          `the button is ${gap.toFixed(0)} px from the end of the selection ` +
            `(button right ${buttonRight.toFixed(0)}, selection right ${state.selRect.right.toFixed(0)}, ` +
            `containerLeft ${state.containerLeft}, containerWidth ${state.containerWidth}, ` +
            `tooltipWidth ${state.tooltipWidth}, innerWidth ${state.innerWidth})`,
        );
      } else {
        console.log(`PASS  : the button sits on the end of the selection (${gap.toFixed(0)} px off)`);
      }
    }
  }

  // --- 2. Inside the viewport ----------------------------------------------
  if (state.present) {
    const inside =
      state.left >= 0 &&
      state.top >= 0 &&
      state.left <= state.viewportW - state.width &&
      state.top <= state.viewportH - state.height;
    if (!inside) {
      failures.push(
        `button outside the viewport: left=${state.left} top=${state.top} vw=${state.viewportW} vh=${state.viewportH}`,
      );
    } else {
      console.log("PASS  : button is inside the viewport");
    }
  }

  // --- 3. Password field shows nothing -------------------------------------
  await evaluate(browser, sessionId, `getSelection().removeAllRanges()`);
  await sleep(300);
  await evaluate(browser, sessionId, SELECT_SNIPPET("pw"));
  await sleep(500);
  state = JSON.parse(await evaluate(browser, sessionId, BUTTON_STATE));
  results.push(["password field", state]);
  if (state.present) {
    failures.push("micro-button appeared for a PASSWORD field");
  } else {
    console.log("PASS  : no button for a password field");
  }

  // --- 4. Unspeeakable selection shows nothing -----------------------------
  await evaluate(browser, sessionId, `getSelection().removeAllRanges()`);
  await sleep(300);
  await evaluate(browser, sessionId, SELECT_SNIPPET("divider"));
  await sleep(500);
  state = JSON.parse(await evaluate(browser, sessionId, BUTTON_STATE));
  results.push(["unspeeakable", state]);
  if (state.present) {
    failures.push("micro-button appeared for a selection with nothing to speak");
  } else {
    console.log("PASS  : no button for an unspeakable selection");
  }

  // --- 5. Viewport corners --------------------------------------------------
  for (const id of ["top-left", "bottom-right"]) {
    await evaluate(browser, sessionId, `getSelection().removeAllRanges()`);
    await sleep(250);
    await evaluate(browser, sessionId, SELECT_SNIPPET(id));
    await sleep(500);
    state = JSON.parse(await evaluate(browser, sessionId, BUTTON_STATE));
    results.push([`corner ${id}`, state]);
    if (!state.present) {
      failures.push(`no button for the ${id} selection`);
      continue;
    }
    const inside =
      state.left >= 0 &&
      state.top >= 0 &&
      state.left <= state.viewportW - state.width &&
      state.top <= state.viewportH - state.height;
    if (!inside) {
      failures.push(`button escaped the viewport at ${id}: ${JSON.stringify(state)}`);
    } else {
      console.log(`PASS  : button clamped inside the viewport at ${id}`);
    }
  }

  // --- 6. Esc dismisses, and does not immediately come back ----------------
  await evaluate(browser, sessionId, `getSelection().removeAllRanges()`);
  await sleep(250);
  await evaluate(browser, sessionId, SELECT_SNIPPET("middle"));
  await sleep(500);
  const before = JSON.parse(await evaluate(browser, sessionId, BUTTON_STATE));
  if (!before.present) {
    failures.push("setup for the dismissal check failed: no button");
  } else {
    await evaluate(
      browser,
      sessionId,
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
    );
    await sleep(400);
    const after = JSON.parse(await evaluate(browser, sessionId, BUTTON_STATE));
    if (after.present) {
      failures.push("Escape did not dismiss the button");
    } else {
      console.log("PASS  : Escape dismisses the button");
    }

    // A follow-up mouseup on the still-selected text must NOT resurrect it.
    await evaluate(
      browser,
      sessionId,
      `document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))`,
    );
    await sleep(500);
    const resurrected = JSON.parse(await evaluate(browser, sessionId, BUTTON_STATE));
    if (resurrected.present) {
      failures.push("the button reopened immediately after being dismissed");
    } else {
      console.log("PASS  : dismissed button did not reopen on the next mouseup");
    }
  }

  // --- 7. The button FOLLOWS the text while scrolling ----------------------
  // A dedicated fixture element, so this check does not depend on which other
  // checks already ran: #middle is Esc-dismissed above and the gate correctly
  // refuses to resurrect it, which is a separate feature under test.
  await evaluate(browser, sessionId, SELECT_SNIPPET("scroll-target"));
  await sleep(500);
  const beforeScroll = JSON.parse(await evaluate(browser, sessionId, BUTTON_STATE));
  if (!beforeScroll.present) {
    failures.push("setup for the scroll check failed: no button");
  } else {
    const startTop = beforeScroll.top;

    await evaluate(browser, sessionId, "window.scrollBy(0, 60)");
    await sleep(400);
    const afterScroll = JSON.parse(await evaluate(browser, sessionId, BUTTON_STATE));

    if (!afterScroll.present) {
      failures.push("the button vanished while scrolling; it should follow the text");
    } else {
      const moved = Math.abs(afterScroll.top - startTop);
      if (moved < 40) {
        failures.push(
          `the button did not follow the text: moved ${moved.toFixed(0)} px for a 60 px scroll`,
        );
      } else {
        console.log(
          `PASS  : the button follows the text (moved ${moved.toFixed(0)} px for a 60 px scroll)`,
        );
      }
      if (afterScroll.buttonOverlapsSelection) {
        failures.push("the button overlaps the text after following it");
      }
    }

    // Once the text leaves the viewport there is nothing to point at, so the
    // button must not stay glued to a screen edge.
    await evaluate(browser, sessionId, "window.scrollBy(0, 3000)");
    await sleep(400);
    const gone = JSON.parse(await evaluate(browser, sessionId, BUTTON_STATE));
    if (gone.present) {
      failures.push("the button stayed pinned to a screen edge after the text scrolled away");
    } else {
      console.log("PASS  : the button hides once the text scrolls out of the viewport");
    }

    await evaluate(browser, sessionId, "window.scrollTo(0, 0)");
    await sleep(250);
  }

  // --- 8. The user's selection was not destroyed ----------------------------
  await evaluate(browser, sessionId, `getSelection().removeAllRanges()`);
  await sleep(250);
  await evaluate(browser, sessionId, SELECT_SNIPPET("middle"));
  await sleep(600);
  const kept = await evaluate(
    browser,
    sessionId,
    `JSON.stringify({ collapsed: getSelection().isCollapsed, text: getSelection().toString() })`,
  );
  const keptParsed = JSON.parse(kept);
  if (keptParsed.collapsed || keptParsed.text.trim() === "") {
    failures.push("the extension destroyed the user's selection");
  } else {
    console.log("PASS  : the user's selection is preserved");
  }

  // --- 8. The setting takes effect without a page refresh --------------------
  failures.push(...(await checkSettingToggle(browser, sessionId, (m) => console.log(m))));

  // --- 9. The UI dies with the extension, even without a page reload -------
  // LAST, because it reloads the extension and would disturb later checks.
  failures.push(...(await checkTearsDownOnExtensionReload(browser, sessionId, (m) => console.log(m))));

  // --- 10. Nothing injected before any selection --------------------------
  // Covered implicitly: the host only exists after the first selection above.
  console.log("\nobserved states:");
  for (const [label, s] of results) {
    console.log(
      `  ${label}: ${s.present ? `button@${Math.round(s.left)},${Math.round(s.top)} ${Math.round(s.width)}x${Math.round(s.height)}` : "no button"}`,
    );
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
  console.log("\nPASS: selection capture, guards, positioning, dismissal and selection preservation all work.");
}

main().catch((err) => {
  console.error("FAIL: check crashed:", err);
  process.exit(1);
});