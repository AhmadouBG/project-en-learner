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

### 8b. Match patterns: explicit schemes + `excludeMatches`, not `!` prefixes

**Chosen:** `matches: ["http://*/*", "https://*/*", "file:///*"]` plus
`exclude_matches` for the three `.pdf` variants.

**Rejected:** `matches: ["<all_urls>", "!*://*/*.pdf", ...]`.

**Why, measured.** Chrome rejected the extension outright:

```
Invalid value for 'content_scripts[0].matches[0]': Invalid scheme. ()
```

A negative match pattern may not use a wildcard scheme, so `!*://*/*.pdf` is not
a legal pattern. The fix is to enumerate the real-world schemes positively and
use `exclude_matches` (a proper Chrome manifest field, exposed by WXT as
`excludeMatches`) for the exclusions.

**Why enumerate schemes instead of `<all_urls>`.** We need a place to hang
exclusions. Listing `chrome://` / `chrome-extension://` nowhere in `matches` also
documents intent: those are exactly the surfaces for the Web Store and Chrome's
built-in PDF viewer, which Chrome refuses to inject into regardless.

**Why exclude `.pdf`.** A PDF URL keeps its original `https://…/file.pdf` address
while Chrome renders it in its extension-based viewer, so it *does* match a broad
https pattern. Excluding it keeps the micro-button off rendered documents.

## 8c. `all_frames` and `match_origin_as_fallback` are load-bearing

**Chosen:** `all_frames: true` and `match_origin_as_fallback: true`.

A DOM selection cannot span frames. If the content script only ran in the top
document (the default), a selection made inside an iframe would be **invisible to
us** — spec 5.1 asks for "selections inside iframes where possible", so this flag
is a product requirement, not an optimisation.

`match_origin_as_fallback` covers `about:blank` and `srcdoc` iframes, which
inherit their parent's origin and therefore match no pattern of their own. WXT
exposes no `matchAboutBlank` option; this is the equivalent and is what the
spec's iframe check needs.

**Verified** by `scripts/check-frames.mjs`, which keys on Chrome's per-frame
isolated world (origin `chrome-extension://<id>`, `auxData.isDefault === false`)
and needs no production debug hook:

```
our isolated worlds: 3 across 3 distinct frames
PASS: top document, same-origin iframe and srcdoc iframe all got the script
```

Two CDP details worth recording, both found empirically:

- Chrome delivers `Runtime.executionContextCreated` on the browser socket with
  **no `sessionId`**, even when attached with `flatten: true`. Filtering on
  `sessionId` silently drops every event and reports "no frames".
- `Runtime.executionContextsCleared` must reset the collected list, or a previous
  navigation's contexts get counted toward the current page.

Note for later phases: with `all_frames`, each frame injects its own micro-button
host. That is correct (only the frame owning the selection shows one) but means N
hosts on a nested-frame page, all of which must be torn down on navigation.

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

## 14. CMUdict: generated, checkpointed, and US-only (Phase 3)

**Source and licence.** `cmusphinx/cmudict`, fetched from GitHub `master` and
pinned by the SHA-256 recorded in the generated manifest
(`81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22` for the
version measured here). The licence is BSD-style (CMU) and requires the
copyright notice and disclaimer in source *and* binary distributions, so the
attribution is a Phase 12 deliverable, not optional.

**Generated, not committed.** Spec 5.2 says to "bundle CMUdict converted to a
compact format"; it does not say to commit it. `cmudict.dict` is 3.5 MB and the
packed form is 2.09 MB, which would dominate the repository. `scripts/build-dict.mjs`
downloads and packs it, the output under `src/ipa/dict/` and the download under
`.cache/` are gitignored, and the shipped extension still bundles the data -- so
there is no runtime network dependency. `npm run build:dict` regenerates;
`npm run check:ipa` verifies.

**Format.** Two files, 2,192,392 bytes total = **60.6% of the raw 3,534 kB**:

| file | size | contents |
|---|---|---|
| `dict.json` | 770 kB | manifest, checkpoints, front-coded word list |
| `dict.bin` | 1,371 kB | phones, one character per phone, with an offset index |

Each phone is a single character: `phoneIndex + stress * 39` indexes a 123-
character alphabet, so a lookup recovers symbol and stress together. The word
list is front-coded (each word stored as a shared-prefix length plus a suffix),
which saved 58% of the word bytes.

**Lazy reading, not eager.** Plain front-coding cannot be searched, because entry
N is defined relative to entry N-1, so decoding entry 92,000 means decoding the
91,999 before it. The first implementation did exactly that: **208 ms** on first
use and a large heap, for data where one word is wanted. Every 64th word is
therefore stored in full as a **checkpoint**; a lookup binary-searches the 2,112
checkpoints and then decodes only the one block. Byte offsets of each block are
stored too -- without them the reader scanned the blob from byte 0, which
measured at 2.07 ms per lookup, *worse* than the eager version it replaced.

**Measured, after load** (spec 7 budget: under 20 ms):

| | eager | lazy (final) |
|---|---|---|
| load + decode | 208 ms | **0.0 ms** (two fetches, no per-entry work) |
| lookup p50 | 0.0016 ms | 0.0146 ms |
| lookup p95 | 0.0075 ms | **0.0238 ms** |
| worst probe | 0.0080 ms | 0.0367 ms |

Lookups got slightly *slower* (0.002 -> 0.024 ms) because each one now decodes a
64-word block. That is the intended trade: a bounded ~24 microseconds instead of
a one-off 208 ms plus permanent memory. Both are far inside the 20 ms budget; the
lazy version wins on cold start and heap, which is what a 2 MB dataset in a
service worker needs.

**Two silent-corruption bugs the build now prevents.** Both produced files that
looked fine and a "success" message:

1. **33,206 entries (25%) were corrupt.** The 64-character base64 alphabet was
   too small for the 117 codes the scheme needs, so `ALPHABET[code]` returned
   `undefined` and the string "undefined" was concatenated into the payload. The
   range guard compared against a hand-written constant (117) rather than the
   real alphabet length, so it never fired. Fixed with a 123-character alphabet,
   the guard bound-checked against `ALPHABET.length`, and two build-time
   assertions: every payload character must be in the alphabet, and every entry
   must survive an encode/decode round trip. The build now refuses to write a
   file that fails either.
2. **22 entries were silently dropped** because CMUdict allows a trailing
   `#` comment (`gdp G IY1 D IY1 P IY1 # abbrev`), and the parser treated `#` as
   a phone. Every Irish and Finnish proper noun in the set was lost, plus `gdp`
   and `hiv` -- words a learner plausibly selects.

**Expectations come from the pinned file, not from memory.** Two assumptions
written from memory were simply wrong: `schedule` is `S K EH1 JH UH0 L` upstream,
not `S CH EH1 D Y UW0 L`; and not every entry has exactly one primary stress --
**144 have none** (`a` = `AH0`, `'cause` = `K AH0 Z`) and **1,789 have more than
one**. Those are correct CMUdict data for reduced function words. The invariant
is "at most one", and `check-ipa.mjs` reports the outliers instead of assuming
they cannot exist.

**Variants.** CMUdict keys alternate pronunciations `word`, `word(2)`,
`word(3)`; there are 9,114 variant entries. Spec Phase 3 names "record" as an
acceptance word because it is ambiguous ("REC-ord" vs "re-CORD"), so
`lookupVariants()` exists to reach them -- `lookup()` cannot, because it strips
everything outside `[a-z']` and would turn `record(2)` back into `record`.

**Not yet wired.** `src/ipa/lookup.ts` compiles, lints and is tested, but no
entrypoint imports it and WXT does not copy `src/ipa/dict/` into the bundle.
`wxt build` therefore still reports 45.84 kB, and the package does not yet
contain the 2.09 MB dictionary. That wiring belongs with Phase 4's pop-up.

---

## 15. Rejected / not yet decided

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