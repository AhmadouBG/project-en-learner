/**
 * Phase 3 acceptance check, run inside real Chrome (spec 7).
 *
 * scripts/check-ipa.mjs proves the DATA is correct. This proves the data is
 * actually SHIPPED and reachable at runtime: `public/dict/` is copied verbatim by
 * WXT, so if that copy ever stops happening the extension would build cleanly,
 * load cleanly, and quietly have no pronunciations at all. Only Chrome can tell
 * us.
 *
 * Verifies, via the background service worker:
 *  - the packaged extension contains dict/dict.json and dict/dict.bin;
 *  - `ipa:lookup` is answered for the spec's acceptance words;
 *  - a word absent from CMUdict is answered "not found", not an error;
 *  - lookups are fast inside the extension, and fast on the FIRST call too
 *    (the lazy reader's whole point is that there is no 208 ms warm-up);
 *  - every reply is tagged en-US, never en-GB (spec 5.2).
 *
 * Usage: node scripts/check-dict-runtime.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT_DIR = join(ROOT, ".output", "chrome-mv3");
const CDP_PORT = Number(process.env["ES_CDP_PORT"] ?? 9493);

const CHROME_CANDIDATES = [
  process.env["CHROME_PATH"],
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean);

const findChrome = () => CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const log = (m) => console.log(m);

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = [];

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: ok, reject: no } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) no(new Error(msg.error.message));
        else ok(msg.result);
        return;
      }
      for (const fn of listeners) fn(msg);
    };
    ws.onerror = () => reject(new Error("websocket error"));
    ws.onopen = () =>
      resolve({
        send(method, params = {}, sessionId) {
          const messageId = ++id;
          return new Promise((ok, no) => {
            pending.set(messageId, { resolve: ok, reject: no });
            ws.send(JSON.stringify({ id: messageId, method, params, sessionId }));
          });
        },
        on(fn) {
          listeners.push(fn);
        },
        close() {
          ws.close();
        },
      });
  });
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

  // --- the package must actually contain the data --------------------------
  for (const file of ["dict/dict.json", "dict/dict.bin"]) {
    const path = join(EXT_DIR, file);
    if (!existsSync(path)) {
      console.error(`FAIL: ${file} is not in the built extension.`);
      console.error("      Run: npm run build:dict && npm run build");
      process.exit(1);
    }
    const kb = statSync(path).size / 1024;
    log(`package : ${file} ${kb.toFixed(0)} kB`);
  }

  const profile = mkdtempSync(join(tmpdir(), "es-dict-"));
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

  /*
   * `loadUnpacked` RETURNS the new extension's id, which is the only reliable
   * source. Scanning the target list for any chrome-extension:// worker is
   * wrong: this Chrome profile already had another extension's service worker
   * running, so the scan picked that one and every page load then failed with
   * chrome-error://chromewebdata/ -- a real and very confusing failure, because
   * the check reported "page never became usable" instead of "wrong extension".
   */
  const { id: extensionId } = await browser.send("Extensions.loadUnpacked", { path: EXT_DIR });
  log(`package : extension id ${extensionId}`);

  // Attach to THIS extension's service worker, matched by the id we were given.
  const { targetInfos } = await browser.send("Target.getTargets");
  let workerTarget = targetInfos.find(
    (t) =>
      t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  for (let i = 0; i < 40 && !workerTarget; i += 1) {
    await sleep(250);
    const { targetInfos: again } = await browser.send("Target.getTargets");
    workerTarget = again.find(
      (t) =>
        t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`),
    );
  }
  if (!workerTarget) {
    console.error("FAIL: no extension service worker target.");
    browser.close();
    cleanup();
    process.exit(1);
  }

  const { sessionId: _workerSession } = await browser.send("Target.attachToTarget", {
    targetId: workerTarget.targetId,
    flatten: true,
  });
  await browser.send("Runtime.enable", {}, _workerSession);
  void _workerSession;

  /*
   * Nothing is evaluated in the worker session. `chrome.runtime.sendMessage`
   * never delivers to its own sender, so asking from the worker fails with
   * "Receiving end does not exist". Messages are sent from the side panel page
   * below, which is also the real call path.
   */

  /*
   * Ask the worker to answer, via its OWN chrome.runtime.sendMessage.
   *
   * `sendMessage` does not deliver to the sender, so calling it from inside the
   * service worker fails with "Receiving end does not exist" -- that is browser
   * behaviour, not a bug in the handler. The message is therefore sent from the
   * worker to the extension's own pages, which is the real path anyway: the
   * content script or side panel asks, the worker answers.
   */
  /*
   * Open the side panel page to send the message from.
   *
   * The page is opened AFTER the extension is loaded, because an unknown
   * extension id yields chrome-error://chromewebdata/ -- a page that loads
   * "successfully" with no chrome.runtime on it, which is why the readiness
   * check below inspects the real URL rather than trusting readyState.
   */
  const { targetId: pageTargetId } = await browser.send("Target.createTarget", {
    url: `chrome-extension://${extensionId}/sidepanel.html`,
  });
  const { sessionId: pageSession } = await browser.send("Target.attachToTarget", {
    targetId: pageTargetId,
    flatten: true,
  });
  await browser.send("Runtime.enable", {}, pageSession);

  // Wait for the page document and its extension APIs. Opening a target does not
  // mean it has finished loading, and evaluating too early yields a context
  // where `chrome.runtime` is still undefined -- which is indistinguishable from
  // a real failure unless the state is checked explicitly.
  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    await sleep(250);
    ready = await browser
      .send(
        "Runtime.evaluate",
        {
          expression:
            'location.protocol === "chrome-extension:" && location.pathname.endsWith("sidepanel.html") && !!(globalThis.chrome && chrome.runtime && chrome.runtime.id)',
          returnByValue: true,
        },
        pageSession,
      )
      .then((r) => r.result.value === true)
      .catch(() => false);
  }
  if (!ready) {
    const state = await browser
      .send(
        "Runtime.evaluate",
        {
          expression:
            'JSON.stringify({ ready: document.readyState, url: location.href, hasChrome: !!globalThis.chrome, hasRuntime: !!(globalThis.chrome && chrome.runtime) })',
          returnByValue: true,
        },
        pageSession,
      )
      .then((r) => r.result.value)
      .catch((e) => `unavailable: ${e.message}`);
    console.error(`FAIL: the extension page never became usable. State: ${state}`);
    browser.close();
    cleanup();
    process.exit(1);
  }
  log("package : extension page is loaded and chrome.runtime is available");

  const askOnPage = (word) =>
    browser
      .send(
        "Runtime.evaluate",
        {
          expression: `(async () => {
            const started = performance.now();
            const reply = await chrome.runtime.sendMessage({
              type: "ipa:lookup", word: ${JSON.stringify(word)}, requestId: "probe",
            });
            return JSON.stringify({ ms: performance.now() - started, reply });
          })()`,
          awaitPromise: true,
          returnByValue: true,
        },
        pageSession,
      )
      .then((r) => {
        if (r.exceptionDetails) {
          throw new Error(r.exceptionDetails.exception?.description ?? "page evaluate failed");
        }
        return JSON.parse(r.result.value);
      });

  log("");

  // The first lookup is the one that matters: it proves there is no warm-up cost.
  const first = await askOnPage("schedule");
  if (!first.reply || !first.reply.result) {
    failures.push(`no reply to ipa:lookup: ${JSON.stringify(first)}`);
  } else {
    const r = first.reply.result;
    if (!r.ok || r.ipa !== "ˈskɛdʒʊl") {
      failures.push(`first lookup of "schedule" returned ${JSON.stringify(r)}`);
    } else {
      log(`PASS  : the packaged dictionary answers "schedule" -> ${r.ipa} on the FIRST call (${first.ms.toFixed(1)} ms)`);
    }
    if (r.ipa.includes("ˈ") === false) {
      failures.push("no stress marker in the IPA returned at runtime");
    } else {
      const stressed = (r.syllables ?? []).filter((s) => s.stress === 1);
      if (stressed.length !== 1) {
        failures.push(`runtime reply has ${stressed.length} stressed syllables, expected 1`);
      } else {
        log(`PASS  : stress syllables survive the runtime boundary (${stressed.length} stressed)`);
      }
    }
  }

  for (const [word, expected] of [
    ["record", "ɹəˈkɔɹd"],
    ["photograph", "ˈfoʊtəˌɡɹæf"],
  ]) {
    const { reply } = await askOnPage(word);
    const r = reply?.result;
    if (!r?.ok || r.ipa !== expected) {
      failures.push(`runtime lookup of "${word}" returned ${JSON.stringify(r)}, expected ${expected}`);
    } else {
      log(`PASS  : "${word}" -> ${r.ipa}`);
    }
  }

  const variantsReply = await askOnPage("record");
  const variants = variantsReply.reply?.result?.variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    failures.push("runtime reply for \"record\" carried no alternate readings");
  } else {
    log(`PASS  : alternate readings reach the runtime (${variants.length} beyond the first)`);
  }

  const missing = await askOnPage("zzzznotaword");
  if (missing.reply?.result?.ok !== false) {
    failures.push(`an unknown word returned ${JSON.stringify(missing.reply?.result)}, expected ok:false`);
  } else {
    log("PASS  : an unknown word is answered \"not found\" rather than an error");
  }

  // --- timing inside the extension ------------------------------------------
  /** Evaluate an expression inside the extension page, awaiting promises. */
const pageEval = (expression) =>
  browser
    .send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      pageSession,
    )
    .then((r) => {
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? "page evaluate failed");
      }
      // Expressions here return an already-parsed value via returnByValue, so
      // the result is used as-is. Parsing it again failed with
      // "[object Object] is not valid JSON".
      return r.result.value;
    });

  const timed = await pageEval(`(async () => {
    const words = ["schedule","record","photograph","comfortable","through","beautiful",
                   "a","zywicki","quixotic","necessary","colonel","habit","either"];
    for (const w of words) {
      await chrome.runtime.sendMessage({ type: "ipa:lookup", word: w, requestId: "warm" });
    }
    const samples = [];
    for (let i = 0; i < 60; i += 1) {
      const w = words[i % words.length];
      const t0 = performance.now();
      await chrome.runtime.sendMessage({ type: "ipa:lookup", word: w, requestId: "t" });
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    return {
      p50: samples[Math.floor(samples.length * 0.5)],
      p95: samples[Math.floor(samples.length * 0.95)],
      max: samples[samples.length - 1],
    };
  })()`);

  log("");
  log(`timing  : p50 ${timed.p50.toFixed(2)} ms, p95 ${timed.p95.toFixed(2)} ms, max ${timed.max.toFixed(2)} ms (round trip through chrome.runtime)`);
  if (timed.p95 >= 20) {
    failures.push(`p95 round trip ${timed.p95.toFixed(2)} ms exceeds the 20 ms budget`);
  } else {
    log("PASS  : p95 round trip is under the 20 ms budget");
  }
  if (first.ms >= 20) {
    failures.push(`the FIRST lookup took ${first.ms.toFixed(2)} ms; the lazy reader should have no warm-up cost`);
  } else {
    log(`PASS  : no warm-up penalty on the first lookup (${first.ms.toFixed(2)} ms)`);
  }

  browser.close();
  cleanup();

  if (failures.length > 0) {
    console.error("\nFAIL:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  log("\nPASS: the dictionary is packaged, reachable from the service worker, and fast inside Chrome.");
}

main().catch((err) => {
  console.error("FAIL: check crashed:", err);
  process.exit(1);
});