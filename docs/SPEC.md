# Task: Build v1.0 ("Tier 0") of the "English Shadowing" Chrome extension

You are a senior front-end / browser-extension engineer. Build a **Manifest V3 extension that works right after install, with NO backend and NO account**. Work in phases. **Finish a phase, run its acceptance checks, report real results, then move on.** Before writing code, inspect the existing repo (`frontend/`: `Panel.html`, `Panel.js`, `Panel.css`, `MeaningView`, `PhoneticView`, `MediaPlayer`) and reuse its visual language (green accent `#4caf50`, existing icons and CSS) where it still fits. Do not use the old FastAPI backend: remove or isolate every call to it.

## 1. Single-purpose statement (every feature must serve it)

> "Practise English pronunciation on any web page: select text, listen to it, shadow it, and review what you practised."

Do not add features outside this purpose (no general translator, no grammar checker, no AI, no gamification beyond what is listed). If a task seems to require one, stop and ask.

## 2. User flow

```
Select text on a page
   → (150 ms) micro-button appears next to the selection
   → click, or shortcut Alt+Shift+S on the current selection
        → POP-UP (quick read): meaning, IPA with stress, 🔊 listen, [Practice]
             → [Practice] → SIDE PANEL (workspace): shadow loop, record, check, save
```

- The pop-up closes on outside click or Esc. The side panel stays open while the user scrolls the page.
- Selected text, accent and speed must carry over from pop-up to side panel with no re-typing.

## 3. Hard constraints

- Manifest V3, TypeScript (strict), Vite + a maintained CRX plugin (verify the current one), Vitest for unit tests. No React unless you justify it; vanilla or a tiny library (Preact/Lit) is preferred to keep the content-script bundle small.
- **No remotely hosted code.** No network calls except: the dictionary API (section 5.3) and an optional link out to YouGlish. No analytics, no telemetry.
- Smallest permission set that works. Expected: `storage`, `contextMenus`, `sidePanel`, host permission for the dictionary API. The micro-button needs a content script on all pages; implement it with `content_scripts` matching `<all_urls>`, but structure the code so it can be switched to `activeTab` + `scripting` easily, and document the trade-off in `docs/DECISIONS.md`.
- All injected UI (micro-button, pop-up) lives in a **shadow DOM** so page CSS cannot break it and ours cannot leak.
- Never run on password fields; skip `chrome://`, the Web Store, and Chrome's PDF viewer (show a friendly message if the user triggers the shortcut there).
- Dark mode and keyboard accessibility (focus management, ARIA labels, Esc to close, visible focus rings) from the start.
- UI languages: English and French via `_locales` (`chrome.i18n`). All visible strings must come from message files.
- Verify every library, API and dataset exists and is maintained before using it. If something is unsuitable, pick the closest alternative and record why in `docs/DECISIONS.md`.

## 4. UI specification

### 4.1 Micro-button
- 28 px round button with the extension logo, placed above or below the selection from `Range.getBoundingClientRect()`, kept inside the viewport.
- Appears ~150 ms after selection ends; hides when the selection clears, on scroll far away, or on Esc.
- Ignores selections longer than ~300 characters (instead show the button, and the pop-up offers to practise only the first sentence).
- First-run tooltip once: "Click to practise this text". Never shown again.

### 4.2 Pop-up (compact, ~320 px wide)
Header: the selected text (truncate), close ×. Body, for a **word**:
- IPA with the stressed syllable highlighted, accent toggle `US | UK`.
- 🔊 Listen button with speed `0.5× / 0.75× / 1×`.
- Meaning: part of speech, first 1 to 2 definitions, one example. Loading skeleton, then content; clear offline/not-found states.
- Buttons: **[Practise pronunciation]** (primary), **[Save]**, and a small "Translate" link that opens Google Translate in a new tab with the text (nothing is sent until the user clicks).

For a **sentence**: IPA per word (collapsible), 🔊 Listen with word-by-word highlight, [Practise pronunciation], [Save]. No meaning section (it needs AI, out of scope).

### 4.3 Side panel (the workspace)
Use `chrome.sidePanel`. Three tabs: **Practise**, **Saved**, **Settings**.

**Practise tab, top to bottom:**
1. Text area (editable; supports pasted subtitles) + accent toggle + speed selector.
2. Phonetic breakdown: per word, IPA with stress colouring; toggle IPA on/off (as in the existing panel).
3. Reference controls: ▶ Listen, ⏹ Stop, 🔁 repeat; word highlight while playing.
4. **Native examples** button: opens `https://youglish.com/pronounce/<text>/english/<accent>` in a small popup window (words and short phrases only; hide it for long sentences). Show "Powered by YouGlish.com" next to it.
5. **Shadow controls:** repeat count (1/3/5), gap length, ▶ Start shadowing.
6. **Record:** ● Record / ⏹ Stop, live level meter, waveform of the user's take, ▶ Play my take, **A/B** (alternates reference TTS and my take), Discard.
7. **Result block:** the recognised transcript, target words coloured green (matched) / red (missed or replaced) / grey (extra words), a "Words recognised: x/y" line (do NOT call this "accuracy" or "pronunciation score"), and a note explaining that this checks which words were recognised, not individual sounds.
8. Save button (and a setting "Save automatically after my first recording", default on).

**Saved tab:** list of saved items (text, IPA, last result, date), search, delete, **Review** mode (flip card: front = text + IPA + 🔊, back = meaning; buttons Again / Good that store a simple box number), Export JSON, Import JSON, Clear all (with confirmation). No scheduling or notifications in this version.

**Settings tab:** default accent, default speed, TTS voice per accent, UI language (EN/FR), "Show button on selection" on/off, "Open practice automatically" (default off), theme (system/light/dark), shortcut hint with a link to `chrome://extensions/shortcuts`, privacy summary, credits.

### 4.4 Onboarding (first run, 3 screens, skippable)
1. "Select any text on a page." 2. "Listen, then shadow it." 3. "Record yourself and review." Ask for the microphone only when the user first presses Record, with a one-line explanation before the browser prompt.

### 4.5 Microcopy and states
Write every empty, loading, offline, error and permission-denied state. Example: mic denied → "Microphone blocked. Click here to allow it" opening the permission helper page. Never show technical errors to users.

## 5. Features and implementation notes

### 5.1 Selection capture
Handle `mouseup`/`keyup` selection, selections inside iframes where possible, editable fields (skip passwords), shadow DOM text where reachable. Ignore events that originate inside our own UI. Do not clear the user's selection. Debounce, and avoid reopening UI that was just dismissed.

### 5.2 IPA, phonemes and stress (offline)
- Bundle **CMUdict** converted to a compact format (trie or sorted JSON), lazy-loaded and cached in memory. Verify its licence and put the attribution in credits.
- Convert ARPAbet to IPA, keep the stress digits (0/1/2) and use them to highlight the primary-stressed syllable.
- CMUdict is US-only. For UK, use the dictionary API's phonetic field when it exists; otherwise show the US transcription and mark it "US". Never claim UK IPA that you did not source.
- Unknown words: fall back to the dictionary API phonetic, then to a simple letter-to-sound approximation clearly marked as approximate.

### 5.3 Meaning
- Background service worker calls a free dictionary API (verify the current one, its terms and rate limits; `api.dictionaryapi.dev` is a candidate). Cache in `chrome.storage.local` with a size cap and expiry. Handle 404 (word not found), offline, and rate limiting.

### 5.4 Listening (TTS)
- Wrap `speechSynthesis`: list voices, filter `en-US` / `en-GB`, pick the best available per accent, handle voices that load asynchronously, handle the Chrome bug where speech stops after ~15 s (chunk long text), speed via `rate`, word highlight via `boundary` events with a timer-based fallback when boundaries are not fired. Explain in Settings that available voices depend on the operating system.

### 5.5 Recording
- `MediaRecorder` plus an `AnalyserNode` for the level meter and the waveform. Output playable audio blob kept in memory only (never stored unless the user explicitly saves an item with audio, which is out of scope for v1.0).
- Auto-stop on ~1.5 s of silence after speech started, and hard stop at 30 s.
- **Microphone permission:** record from the side panel (an extension page, so the permission belongs to the extension). Also build `permission.html`, a tiny extension page opened in a tab, that requests mic access once and tells the user to return. Use it when the prompt is dismissed or blocked. Test this flow carefully.

### 5.6 Word-level check (Web Speech API)
- Run `SpeechRecognition` (`en-US` or `en-GB` from the accent) during the take. Request alternatives and keep confidence values.
- Normalise both texts (lowercase, strip punctuation, expand simple contractions consistently), align word tokens with a Levenshtein-based alignment, and produce: matched / substituted / missing / extra, per target word.
- Show an explicit privacy note near the Record button: Chrome's speech recognition may send audio to Google's service. Make the check optional (setting "Check my words after recording", default on), so users can record and compare by ear only.
- Handle unsupported/blocked recognition gracefully (feature hidden, rest still works).

### 5.7 Shadow loop
State machine: `idle → playing → countdown(3-2-1) → recording → review → (repeat n times) → done`. Cancel at any time. Show progress ("Round 2 of 3"). After the last round, run the word check on the final take (or the best one) and show the result block.

### 5.8 Saved items and review
- Schema (versioned for migrations): `{id, text, kind: "word"|"sentence", ipa, accent, createdAt, attempts, lastResult: {recognised, total, ts}|null, box: number}`.
- Store in `chrome.storage.local`, enforce a sane item cap, and handle quota errors.
- Export/import JSON with validation. Do not store the page URL or title unless a setting explicitly enables it.

### 5.9 Shortcut, context menu
- `commands`: `Alt+Shift+S` opens the pop-up for the current selection. Context menu "Practise pronunciation" on selected text.
- Toolbar icon click opens the side panel (for pasted text).

### 5.10 Messaging and architecture
- Content script (selection, micro-button, pop-up) ⇄ background (dictionary fetch, cache, `sidePanel.open`, context menu, commands) ⇄ side panel. Define one typed message protocol in `src/shared/messages.ts` and one typed storage layer.
- `chrome.sidePanel.open()` needs a user gesture: verify that the content-script click, the shortcut and the context menu all open it. If a path fails, implement a clear fallback (for example the pop-up shows "Open the panel from the toolbar icon").

## 6. Suggested structure

```
extension/
├── manifest.json (generated or typed)
├── src/
│   ├── content/        # selection, micro-button, popup (shadow DOM)
│   ├── background/     # service worker: api, cache, commands, menus
│   ├── sidepanel/      # tabs: practise, saved, settings
│   ├── permission/     # permission.html helper
│   ├── shared/         # messages, storage, i18n, types
│   ├── services/       # ipa (cmudict), tts, recorder, recognition, diff, shadow
│   └── data/           # cmudict compact file + build script
├── _locales/en, fr/
├── scripts/build_cmudict.ts
├── tests/
└── docs/DECISIONS.md, PRIVACY.md, STORE_LISTING.md, LICENSES.md
```

## 7. Phases and acceptance checks

**Phase 1: Foundation.** Project, manifest, build, message protocol, storage layer, i18n scaffolding, shadow-DOM mount helper. *Check:* extension loads, side panel opens from the toolbar icon, no errors in any console.

**Phase 2: Selection and micro-button.** *Check:* works on Wikipedia, GitHub, a news site, a page with an iframe; does not appear on password fields; hides correctly; positions correctly near viewport edges and after scrolling.

**Phase 3: IPA and stress.** CMUdict build script + lookup. *Check:* "schedule", "record" (noun vs verb), "photograph" show correct stress highlighting; lookup of a common word takes under 20 ms after load; unit tests cover ARPAbet→IPA.

**Phase 4: Meaning and pop-up.** *Check:* pop-up shows meaning for words, offline and not-found states are handled, cached lookups are instant, pop-up closes on outside click and Esc.

**Phase 5: TTS.** *Check:* US/UK voice selection, speed control, long-text chunking, word highlight; test on at least Windows and macOS or document what could not be tested.

**Phase 6: Side panel and practise tab.** Port the existing panel UI. *Check:* text carries over from the pop-up; all controls are keyboard reachable; dark mode works.

**Phase 7: Recording and permission flow.** *Check:* first-time permission prompt, denied state, helper-page recovery, level meter, waveform, auto-stop on silence, playback and A/B.

**Phase 8: Word check.** *Check:* unit tests for the alignment (exact match, one substitution, one missing word, extra word, punctuation/case differences, contractions); manual test with a correct and a deliberately wrong reading; the unsupported case is handled.

**Phase 9: Shadow loop.** *Check:* 3-round loop completes, cancel works at every state, no overlapping audio, no stuck microphone indicator after finishing.

**Phase 10: Saved items, review, export/import.** *Check:* data survives browser restart; import rejects invalid files with a clear message; quota error is handled.

**Phase 11: Settings, shortcut, context menu, onboarding, EN/FR.** *Check:* every string is translated, the shortcut works on a selection, onboarding appears once.

**Phase 12: Hardening and store prep.** Test matrix: Wikipedia, GitHub, YouTube comments, Google Docs, an iframe page, a strict-CSP site, offline mode, denied mic, no voices installed, low-end laptop. Produce `docs/STORE_LISTING.md` (single-purpose statement, description, permission justifications one by one), `docs/PRIVACY.md` (what stays on the device, what the dictionary API and Chrome speech recognition receive, the YouGlish link), and `docs/LICENSES.md` (CMUdict, dictionary API, YouGlish attribution, every npm dependency). Report package size and content-script bundle size. *Check:* lint (`eslint`), type-check and tests pass, and a production build loads in a clean Chrome profile.

## 8. Out of scope for v1.0 (do not build)

AI features (contextual definition, grammar correction), phoneme-level scoring, pitch or waveform overlay against a reference, spaced-repetition scheduling and notifications, streaks and gamification, cloud sync, accounts, any backend, downloading or caching YouGlish content, Firefox/Edge ports.

## 9. Quality bar

- TypeScript strict, ESLint clean, unit tests for IPA conversion, alignment/diff, shadow state machine, storage migrations.
- Content-script bundle as small as possible; no work on pages until the user selects text.
- No `eval`, no inline scripts, no remote code. Sanitise everything inserted into the DOM.
- Never log the user's text or audio.
- Report real measured numbers (timings, bundle sizes), not estimates. Do not mark a phase done without running its check.

Start with Phase 1. Before coding, reply with: a short plan, the exact dependencies you intend to use (with versions and licences), the risks you see, and any question that blocks you.