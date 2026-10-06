# DECISIONS

Architecture and dependency decisions for English Shadowing v1.0 ("Tier 0").

Every entry records what was chosen, what was rejected, and **measured** evidence
where measurements were possible. Estimated numbers are labelled as such.

- Environment used for all measurements: Windows 11, Chrome/154.0.8037.93,
  Node v24.15.0, npm 11.12.1. Measured 2026-10-05.

---

## 1. Single-purpose statement

> Practise English pronunciation on any web page: select text, listen to it,
> shadow it, and review what you practised.

This governs every scope decision. Anything that does not serve this sentence is
out of scope (spec §8). Concretely excluded from v1.0: AI features, phoneme-level
scoring, spaced repetition, streaks, cloud sync, accounts, and any backend.

---

## 2. Build tool: WXT 0.21.4 instead of `@crxjs/vite-plugin`

**Chosen:** `wxt` 0.21.4 (MIT), which is Vite 8.3.2 under the hood.

**Rejected:** `@crxjs/vite-plugin` 2.7.1 (MIT).

**Why.** Both are maintained, but the ecosystem comparison puts CRXJS in reduced
velocity / maintenance mode with a small team that must track every Vite major and
Chrome platform change. WXT published 0.21.4 on 2026-08-11 and is the
actively-developed option. WXT also removes work we would otherwise hand-write:
file-based entrypoints, manifest generation from typed entrypoint config,
built-in i18n message generation, storage wrappers, and shadow-DOM content-script
UI mounting (which spec §3 requires for *all* injected UI).

**Cost of the choice.** WXT does not support ESM content scripts
(`ESM Content Scripts ❌ / WIP`), which CRXJS does. This is not a blocker: our
content script is a classic script bundle and we need no ESM content scripts.
WXT is also Chromium-oriented, which suits a Chrome Web Store target (spec §8 puts
Firefox/Edge ports out of scope).

## 3. No UI framework: vanilla TypeScript

**Chosen:** vanilla TS + DOM APIs.

**Rejected:** React, Preact 11.0.0, Lit 3.3.3.

**Why.** Spec §3 prefers vanilla or a tiny library to keep the content-script
bundle small, and requires "no work on pages until the user selects text". Zero
framework means the content script ships the watcher and the two small UI shells
and nothing else. Preact would have added ~4 kB gzip for components that are
mostly one `<button>` and one `<div>`.

## 4. TypeScript 5.9.3, not 7.0.2

TypeScript 7.0.2 is the current release, but `typescript-eslint` 8.71.0 declares
`typescript: ">=4.8.4 <6.1.0"`. Type-aware linting is non-negotiable here (it is
what forbids `innerHTML`, `any` and floating promises), so we pin the newest
TypeScript the linter supports. Revisit when `typescript-eslint` widens its range.

Other versions, all pinned exact, licences verified against the npm registry:

| Package | Version | Licence |
|---|---|---|
| `wxt` | 0.21.4 | MIT |
| `vite` | 8.3.2 | MIT |
| `typescript` | 5.9.3 | Apache-2.0 |
| `vitest` | 5.0.3 | MIT |
| `@vitest/coverage-v8` | 5.0.3 | MIT |
| `eslint` | 10.12.0 | MIT |
| `typescript-eslint` | 8.71.0 | MIT |
| `@eslint/js` | 10.0.1 | MIT |
| `globals` | 17.13.0 | MIT |
| `@types/chrome` | 0.3.4 | MIT |
| `happy-dom` | 20.14.5 | MIT |

**Runtime dependencies: none.** TTS, recording, level metering and word checking
all use native browser APIs, which is also what makes the "no remotely hosted
code" rule (§3) trivially true.

---

## 5. Dictionary API: `freedictionaryapi.com`, not `api.dictionaryapi.dev`

Spec §5.3 nominated `api.dictionaryapi.dev` as a *candidate* and told us to
verify the current one. Measured 2026-10-05:

| Endpoint | Result |
|---|---|
| `api.dictionaryapi.dev/api/v2/entries/en/hello` | **HTTP 522**, ~19.7 s, three attempts — Cloudflare reports it cannot reach the origin |
| `freedictionaryapi.com/api/v1/entries/en/hello` | **HTTP 200 in 288 ms** |

**Chosen:** `https://freedictionaryapi.com/api/v1/entries/en/{word}`.
Keyless, no signup, documented limit 1000 requests/hour/IP, data sourced from
Wiktionary under CC BY-SA 4.0 (attribution in Settings/credits and
`docs/LICENSES.md`).

This is also *better* for our purpose, not merely available:

- Transcriptions are **source-tagged**: `"Received Pronunciation"` (UK) and
  `"General American"` (US). Spec §5.2 requires real sourced UK IPA and forbids
  claiming UK IPA we did not source; CMUdict is US-only, so without tagged
  source data we could never satisfy UK honestly. `dictionaryapi.dev` returns a
  single undifferentiated `phonetics[].text`.
- The response provides `partOfSpeech`, `senses[].definition` and
  `senses[].examples`, which is exactly the pop-up content in §4.2.

**Gotcha recorded:** an unknown word returns **HTTP 200 with `entries: []`**, not
404. The client must treat an empty `entries` array as not-found.

Host permission is exactly `https://freedictionaryapi.com/*` — the only host
permission in the extension.

---

## 6. YouGlish: link-out only, no API

Spec §4.3 specifies a "Native examples" button that opens YouGlish, and §3 allows
only a link out to it. We verified the YouGlish API exists and measured its terms
at `youglish.com/api/plans`:

| Tier | Access | Cost |
|---|---|---|
| Widget | "Free for non-commercial education use" | €0 |
| JS API | "Free for non-commercial education use" | €0 |
| REST API (Hobby) | 500 req/day | **€25/month** |

Every tier is behind `Login / Signup → My Apps → API key`, and the API Licence
Terms prohibit building our own API around theirs without written permission.

**Decision: link out only.** Using the API would require an account, which
directly contradicts the product's headline requirement ("works right after
install, with NO backend and NO account"), and REST would add a paid dependency
for a feature that is explicitly optional in the spec.

All YouGlish access is funnelled through a single call site so a free Widget
embed can be added later, behind a setting, if a non-commercial education key is
ever obtained. That keeps the door open without making it a requirement.

Verified reachable: `youglish.com/pronounce/schedule/english/us` → HTTP 200.

---

## 7. `<all_urls>` content script, structured to be swappable for `activeTab`

Spec §3 asks for a content script on all pages but requires it to be structured
so it can move to `activeTab` + `scripting`, with the trade-off documented.

**Current:** `content_scripts.matches = ["<all_urls>"]`, which grants page access
without an install-time permission warning.

**Why this is the right default.** The micro-button must be available on any page
for the extension to serve its purpose. `activeTab` would work, but only after
the user clicks the toolbar icon, which breaks the core flow: select text →
button appears.

**What switching would cost.** With `activeTab`, the background must call
`chrome.scripting.executeScript` after each action-bar click and after each
`commands` / `contextMenus` event. Keyboard shortcut → button would no longer
work at all, because there is no gesture to grant the tab. That is a product
regression, not just an implementation change.

**How the code is structured for it.** All content-script behaviour lives in
`src/content/` behind a factory. `src/entrypoints/content.ts` only declares *how*
it is loaded, so the switch is a one-line manifest change plus injecting that
module from the background.

Recorded for `docs/STORE_LISTING.md`: the `<all_urls>` content script is required
for the single stated purpose.

---

## 8. Restricted pages

Never runs on `chrome://` (enforced by Chrome itself), the Web Store (also
Chrome-enforced), and we additionally skip the PDF viewer and other
non-HTML surfaces. Pressing the shortcut there shows a friendly message rather
than doing nothing. Password fields are skipped in the selection watcher
(Phase 2).

---

## 9. TTS runs in an extension page, never in the page context

`speechSynthesis` is a DOM API, and MV3 service workers have no DOM. So all TTS
must happen in the side panel or pop-up, never in the content script.

Two consequences, stated rather than hidden:

1. Audio requires an extension page to be open. Closing the side panel stops
   playback. This is acceptable because the practice loop lives in the panel.
2. Running TTS inside the extension also avoids contending with any
   `speechSynthesis` usage by the host page.

We use `speechSynthesis` rather than `chrome.tts`: `chrome.tts` cannot be rate
controlled, and speed control is core to shadowing.

## 10. macOS is not verified

No macOS hardware was available. TTS voice selection, the Chrome ~15 s speech
cut-off workaround, and the word-highlight fallback are therefore:

- selected by BCP-47 tag (`en-US` / `en-GB`) with a documented fallback chain,
  **never** by hardcoded voice names, because voice sets differ per OS;
- covered by unit tests against a mocked `speechSynthesis`;
- **not** verified on macOS. This is stated plainly in `docs/STORE_LISTING.md`.

The most likely macOS surprise for users is the set of installed `en-GB` voices,
so Settings will say explicitly that available voices depend on the operating
system.

---

## 11. Icons are generated, not committed as binaries by hand

`scripts/make-icons.mjs` writes the four PNGs from one parametric definition
using only Node built-ins (a hand-rolled PNG encoder, ~160 lines, MIT-safe as our
own code). This keeps the icon set consistent and reproducible, and keeps binary
assets out of review diffs. Colours come from the previous panel's palette.

## 12. Legacy `frontend/` was deleted

The old `frontend/` directory was a second MV3 manifest whose code called
`localhost:8000` (`src/api.js`, `config.js`, `MediaPlayer.js`, `PhoneticView.js`,
`MeaningView.js`). Leaving it would have kept a live FastAPI coupling in the tree
that nothing builds.

**Removed.** Everything was committed first, so it is recoverable from git. The
visual language worth keeping (`Panel.css` palette and gradients) was copied to
`src/styles/legacy-panel-reference.css` as the reference for the new stylesheet,
and the old icons to `src/assets/`.

`MeaningView` is deliberately not ported: it fetched AI-generated contextual
definitions, which spec §8 excludes from v1.0. The pop-up's meaning section is
served entirely by the dictionary API instead.

---

## 12b. Quota handling trims the cache, it never wipes it

An earlier draft recovered from `chrome.storage.local` quota errors by writing
`dictCache: []` — dropping the whole dictionary cache in one go to make room.

**That is wrong**, and it was corrected: silently deleting every cached definition
is user-visible data loss traded for saving a handful of re-fetches. Since the
cache exists precisely so lookups are instant and free, wiping it also throws
away the offline resilience the spec asks for in §4.2.

Current behaviour on a quota failure:

1. Retry, dropping the **oldest quarter** of cache entries each time (the cache
   is kept newest-first, so the tail is oldest).
2. Stop as soon as the write fits, which in practice costs a few re-lookups
   rather than the whole cache.
3. If it still will not fit with an empty cache, throw `QuotaExceededError` and
   let the UI ask the user what to discard.

`saved` (practice history) and `settings` are **never** touched by this path.
Purging the cache is only possible through the explicit, user-initiated
`clearDictCache()`, which the Settings UI will wire to an explicit confirm.

Covered by `tests/storage-io.test.ts`, including a test asserting that a saved
item survives a quota failure.

## 13. Verification approach

Spec §9 forbids marking a phase done without running its check, and requires real
numbers. Three layers:

1. **Unit tests** — Vitest, thresholds enforced at 70 % (currently 88 % stmts /
   83.8 % branches).
2. **Real browser** — `scripts/check-phase1.mjs` drives real Chrome over the
   DevTools Protocol and fails on *any* console error. It loads the extension via
   `Extensions.loadUnpacked` because headless Chrome on this machine ignores the
   `--load-extension` command-line flag; that was found empirically after the
   flag appeared to work but produced no extension target.
3. **Static gates** — `npm run lint` (type-aware) and `npm run compile`
   (`tsc --noEmit`, `strict` plus `exactOptionalPropertyTypes`,
   `noUncheckedIndexedAccess`, `erasableSyntaxOnly`).

Linting forbids `innerHTML`/`outerHTML` outright, since selected page text and
dictionary responses are untrusted (spec §9).

### Measured Phase 1 results

| Check | Result |
|---|---|
| `eslint .` | clean, 0 errors 0 warnings |
| `tsc --noEmit` | clean |
| `vitest run` | 65 passed / 65 |
| Coverage | 88 % stmts, 83.84 % branches, 86.48 % funcs, 89.37 % lines |
| `wxt build` | success, **15.95 kB total** |
| Extension loads in clean profile | pass, id assigned, MV3 service worker running |
| Side panel renders + keyboard operable | pass (3 tabs, roving tabindex, ArrowRight swaps panel) |
| Console errors in any context | **none** |
| Manifest permissions | `storage`, `contextMenus`, `sidePanel` — exactly as specified |

Per-file build output:

```
manifest.json                839 B
sidepanel.html             2.11 kB
background.js              1.46 kB
chunks/sidepanel-*.js      1.72 kB
content-scripts/content.js 3.50 kB
assets/sidepanel-*.css     2.02 kB
_locales/en/messages.json  1.65 kB
_locales/fr/messages.json  1.68 kB
icon/{16,32,48,128}.png    124-486 B
Total                     15.95 kB
```

**Content-script bundle: 3.50 kB uncompressed, and it is inert.** Phase 1 attaches
no listeners and inserts no DOM (spec §9: "no work on pages until the user selects
text"); the 3.50 kB is WXT's runtime plus this module. Real numbers will be
re-measured at Phase 12 with the CMUdict chunk lazy-loaded.

---

## 14. Rejected / not yet decided

- **`chrome.offscreen`:** not used. A document for `speechSynthesis` is not needed
  because the side panel is already a document, and offscreen documents add a
  permission.
- **CSP `sandbox` for the content script:** not used. Our UI goes into a shadow
  root with an inline `<style>`, which page CSP does not affect, and `sandbox`
  would break page-word access. Recorded because it is the usual hardening step
  and reviewers may ask.
- **IndexedDB:** not used. `chrome.storage.local` (spec §5.8) is the required store
  and IndexedDB in a service worker is awkward; the removed `indexedDB.js` is gone.
- **Internationalisation runtime:** built on `chrome.i18n` message files only, with
  no i18n library, per spec §3.