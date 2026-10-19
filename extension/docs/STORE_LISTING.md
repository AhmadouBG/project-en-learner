# Chrome Web Store listing — English Shadowing

## Single purpose

> Practise English pronunciation on any web page: select text, listen to it,
> shadow it, and review what you practised.

Every feature serves that one sentence. There is no translator, no grammar
checker, no AI, no gamification and no backend.

## Short description (max 132 characters)

> Select English text on any page, hear it, shadow it, record yourself, and see which words you recognised.

## Detailed description

English Shadowing turns any web page into pronunciation practice.

- **Select text.** A small button appears next to what you selected. Click it (or
  press `Alt+Shift+S`) for a quick-read pop-up with the meaning, IPA and audio.
- **Hear it.** US or UK pronunciation, adjustable speed, with the stressed
  syllable highlighted and the spoken word highlighted while it plays.
- **Shadow it.** The side panel plays the phrase, counts you in, records your
  turn, and repeats for as many rounds as you chose. Cancel any time.
- **See what was recognised.** After a take, the panel colours each target word
  green (recognised), red (missed or replaced) or grey (extra), and shows a
  "Words recognised: x/y" line. This checks *which words were recognised*, not
  how good your accent is.
- **Review.** Save phrases and revisit them as flip cards (front: text + IPA +
  audio; back: meaning), with Again / Good to sort them.
- **Yours.** English or French interface, light/dark/system theme, keyboard
  accessible, and a small permission set.

**Private by design.** Your text, saved items and recordings stay on your
device. The only server the extension talks to is the free dictionary API, and
it receives just the single word whose meaning you asked for. See the privacy
policy for the full list.

Everything works offline for words already cached, and pronunciation playback
uses the voices already installed on your computer.

## Permission justifications (one by one)

| Permission | Why it is requested | What it is used for |
|---|---|---|
| `storage` | Save your settings and saved items locally. | Accent, speed, voice, language, theme, toggles, the practice hand-off target, and the saved-item list with its review boxes. Nothing leaves the device. |
| `contextMenus` | Add one right-click entry on selected text. | "Practise pronunciation" sends the selection to the side panel. No other menu items are added. |
| `sidePanel` | Host the practice workspace. | The side panel is the recording/shadowing/review UI. The toolbar icon opens it via `sidePanel.setPanelBehavior`, so no `action` permission is needed. |
| Host permission `https://freedictionaryapi.com/*` | Look up a word's meaning. | The background service worker sends the **single selected word** and receives its definitions and (for UK) a phonetic transcription. This is the only outbound request the extension makes besides links you click. |
| Content script on `file://`, `http://`, `https://` (declared in `content_scripts`, not an install prompt) | Detect a text selection and show the micro-button / pop-up. | Reads the current selection after a `mouseup`/`keyup`, and mounts UI in a shadow root. It skips password fields, `chrome://` pages, the Web Store and PDFs. The code is written so this can move to `activeTab` + `scripting`; see DECISIONS.md for the trade-off. |

No other host permissions, no `tabs`, no `clipboardRead`, no `webRequest`, no
`activeTab`/`scripting`, and no `downloads` permission.

## Data use disclosures

- The extension does **not** collect or transmit analytics, telemetry, or
  personal data to the developer. There is no developer server.
- The free dictionary API receives the selected word; Chrome's speech
  recognition may receive your audio **only** while "Check my words after
  recording" is on (default on, can be turned off).
- YouGlish and Google Translate are ordinary outbound links you must click.
- No remotely hosted code: all JavaScript ships inside the package. The
  dictionary network call uses `fetch`; there is no `eval`, no inline script and
  no remote module.

## Category, language and assets

- Category: Productivity (or Education).
- Default language: English; French UI included.
- Icons: 16/32/48/128 px in `icon/`.
