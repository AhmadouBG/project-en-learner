# Privacy — English Shadowing

Last updated: 2026-10-19 · version 1.0.0

English Shadowing runs entirely in your browser. There is **no account, no
server of ours, and no analytics**. Nothing is collected, transmitted or sold by
the developer. This page lists the few places where data can leave your device,
and only because a feature you asked for needs it.

## Stays on your device

| Data | Where | Notes |
|---|---|---|
| Text you type or paste | `chrome.storage.local` (current session) | Cleared when you replace it. |
| Saved items and review boxes | `chrome.storage.local` | Until you delete them or click **Clear all**. |
| Your recordings | Memory only | Never written to disk, never uploaded. Discarded when you close the panel or press **Discard**. |
| Settings (accent, speed, voice, language, theme, toggles) | `chrome.storage.local` | — |
| Dictionary cache | `chrome.storage.local` | Capped at 500 words, expires after 30 days. |

The extension does not store the page URL or title of sites you visit. It never
reads your clipboard and never logs your text or audio.

## Can leave your device

1. **The free dictionary API — the selected word only.**
   When a word's meaning is shown (quick-read pop-up, or the back of a review
   card), the background service worker sends that **single word** to
   `https://freedictionaryapi.com`. No sentence, no page address, no
   identifiers. The reply is cached locally so repeat lookups stay offline. If
   you are offline, the lookup fails and the extension says so.

2. **Chrome's speech recognition — your audio, only if word checking is on.**
   "Check my words after recording" is on by default. While it is on, Chrome's
   `SpeechRecognition` converts your take to text, and Chrome may send the audio
   to Google's speech service to do that. Turn the setting off to record and
   compare by ear only; then your audio never leaves the machine. The note by
   the Record button says the same thing.

3. **YouGlish — only when you click it.**
   The **Native examples** button opens
   `https://youglish.com/pronounce/<text>/english/<accent>` in a small window.
   The selected text becomes part of that web address, so YouGlish sees it. It
   is a normal website visit with its own privacy policy; nothing is sent until
   you click.

4. **Google Translate — only when you click it.**
   The quick-read pop-up's small **Translate** link opens
   `https://translate.google.com/?sl=en&tl=fr&text=<text>`. Again, the text is
   part of the address and is only sent when you click.

Pronunciation playback uses the voices already installed on your computer
(`speechSynthesis`). It makes no network request.

## Permissions, and why

- **`storage`** — save your settings and saved items locally.
- **`contextMenus`** — add "Practise pronunciation" to the right-click menu on
  selected text.
- **`sidePanel`** — show the practice workspace in Chrome's side panel.
- **`https://freedictionaryapi.com/*`** — the one network call above.

The micro-button needs a content script on web pages (declared with
`content_scripts`, which is not an install-time permission prompt). See
`DECISIONS.md` for the `activeTab` trade-off.

## Deleting your data

- **Settings → Clear the dictionary cache** removes cached definitions.
- **Saved → Clear all** removes every saved item after a confirmation.
- Removing the extension deletes everything in `chrome.storage.local`.

## Contact

Open an issue on the project's repository. Do not include your recorded audio or
private page text in a report.
