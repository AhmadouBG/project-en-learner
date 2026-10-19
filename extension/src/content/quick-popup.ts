/**
 * The quick-read pop-up (spec 4.2).
 *
 * Injected into a shadow root so page CSS cannot break it and ours cannot leak
 * (spec 3). It shows meaning, IPA with the stressed syllable highlighted, a
 * Listen control, Practise / Save, and a Translate link.
 *
 * TTS runs here rather than in the side panel because the user must be able to
 * hear the selection without leaving the page. The speaker wrapper is the same
 * one the panel uses, so voice selection, chunking and the boundary fallback are
 * identical (see docs/DECISIONS.md, "Quick-read pop-up TTS").
 */

import { placeNear, trapFocus, el, watchForDismissal, type ShadowUiController } from "../ui/shadow";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import type { ResolvedSelection } from "./selection";
import type { Translate } from "../shared/i18n";
import type {
  Accent,
  DictionaryEntry,
  DictionaryFailure,
  IpaResult,
  PracticeKind,
} from "../shared/messages";
import { ACCENT_LABELS, classifyText } from "../shared/messages";
import type { Settings } from "../shared/storage";
import { saveDraft } from "../shared/saved";
import { requestDictionary, requestIpa } from "../shared/requests";
import {
  chooseReading,
  joinIpa,
  stressSegments,
  tokenizeWords,
  wordIndexAt,
  type IpaReading,
} from "../ipa/display";
import { Speaker, browserSpeechSource, SPEEDS } from "../services/tts";
import type { Syllable } from "../ipa/arpabet";

const WIDTH = 320;

const CSS = `
:host { --es-green: #4caf50; --es-green-dark: #056b16; }
.es-root { position: fixed; top: 0; left: 0; z-index: 2147483646; pointer-events: none; }
.es-root > * { pointer-events: auto; }

.es-pop {
  width: ${WIDTH}px;
  max-height: min(70vh, 460px);
  display: flex;
  flex-direction: column;
  background: #ffffff;
  color: #202124;
  border: 1px solid #e1e8ed;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
  font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
  overflow: hidden;
  --es-muted: #5f6368;
  --es-border: #e1e8ed;
  --es-wash: #f3f7f4;
  --es-chip: #e8f5e9;
  --es-chip-ink: #056b16;
  --es-danger: #b3261e;
  --es-focus: #0b57d0;
  --es-skeleton: #eceff1;
  --es-hit: rgba(76, 175, 80, 0.28);
}

@media (prefers-color-scheme: dark) {
  .es-pop:not(.es-light) {
    background: #202124;
    color: #e8eaed;
    border-color: #3c4043;
    --es-muted: #bdc1c6;
    --es-border: #3c4043;
    --es-wash: #292a2d;
    --es-chip: #1e2b20;
    --es-chip-ink: #a5d6a7;
    --es-danger: #f2b8b5;
    --es-focus: #8ab4f8;
    --es-skeleton: #303134;
    --es-hit: rgba(129, 199, 132, 0.3);
  }
}

.es-pop.es-dark {
  background: #202124;
  color: #e8eaed;
  border-color: #3c4043;
  --es-muted: #bdc1c6;
  --es-border: #3c4043;
  --es-wash: #292a2d;
  --es-chip: #1e2b20;
  --es-chip-ink: #a5d6a7;
  --es-danger: #f2b8b5;
  --es-focus: #8ab4f8;
  --es-skeleton: #303134;
  --es-hit: rgba(129, 199, 132, 0.3);
}

.es-head {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 10px 8px 12px;
  border-bottom: 1px solid var(--es-border);
}

.es-title {
  flex: 1;
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}

.es-close {
  flex: none;
  width: 26px; height: 26px;
  border: none; border-radius: 50%;
  background: transparent; color: var(--es-muted);
  font-size: 18px; line-height: 1; cursor: pointer;
}
.es-close:hover { background: var(--es-wash); color: inherit; }

.es-body { padding: 10px 12px 12px; overflow-y: auto; display: grid; gap: 10px; }

.es-ipa-row { display: flex; align-items: flex-start; gap: 8px; }
.es-ipa {
  flex: 1;
  font-size: 17px;
  letter-spacing: 0.2px;
  line-height: 1.5;
  word-break: break-word;
}
.es-stress { color: var(--es-chip-ink); font-weight: 700; }
.es-stress-dot { text-decoration: underline; text-decoration-thickness: 2px; }
.es-ipa.is-speaking { animation: es-pulse 1s ease-in-out infinite; }
@keyframes es-pulse { 50% { opacity: 0.55; } }

.es-accent { display: flex; border: 1px solid var(--es-border); border-radius: 6px; overflow: hidden; flex: none; }
.es-accent button {
  border: none; background: transparent; color: var(--es-muted);
  font: inherit; padding: 3px 7px; cursor: pointer;
}
.es-accent button[aria-pressed="true"] { background: var(--es-chip); color: var(--es-chip-ink); font-weight: 600; }

.es-badge {
  display: inline-block; margin-left: 6px; padding: 0 5px;
  border: 1px solid var(--es-border); border-radius: 4px;
  font-size: 10px; font-weight: 600; color: var(--es-muted); vertical-align: 3px;
}

.es-note { color: var(--es-muted); font-size: 11px; }
.es-warn { color: var(--es-danger); font-size: 11px; }

.es-listen-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.es-listen {
  display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--es-border); border-radius: 999px;
  background: var(--es-wash); color: inherit; font: inherit;
  padding: 5px 12px; cursor: pointer; font-weight: 600;
}
.es-listen:hover { border-color: var(--es-green); }
.es-speed { margin-left: auto; display: flex; align-items: center; gap: 5px; color: var(--es-muted); }
.es-speed select {
  font: inherit; padding: 2px 4px; border-radius: 5px;
  border: 1px solid var(--es-border); background: transparent; color: inherit;
}

.es-meaning { border-top: 1px solid var(--es-border); padding-top: 9px; display: grid; gap: 7px; }
.es-section-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--es-muted); }
.es-pos { font-style: italic; color: var(--es-muted); font-size: 12px; }
.es-defs { margin: 0; padding-left: 16px; display: grid; gap: 4px; }
.es-example { color: var(--es-muted); font-style: italic; }

.es-skeleton { display: grid; gap: 6px; }
.es-bar { height: 9px; border-radius: 4px; background: var(--es-skeleton); animation: es-shimmer 1.3s ease-in-out infinite; }
.es-bar.short { width: 62%; }
@keyframes es-shimmer { 50% { opacity: 0.45; } }

.es-sentence { line-height: 1.7; }
.es-sentence .es-word { border-radius: 3px; }
.es-sentence .es-word.is-active { background: var(--es-hit); }
.es-sentence-ipa summary { cursor: pointer; color: var(--es-muted); font-size: 12px; }
.es-word-ipa { columns: 2; column-gap: 14px; margin: 7px 0 0; padding: 0; list-style: none; font-size: 12px; }
.es-word-ipa li { break-inside: avoid; margin-bottom: 4px; }
.es-word-ipa .w { font-weight: 600; }

.es-actions {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  border-top: 1px solid var(--es-border); padding-top: 10px;
}
.es-primary {
  border: none; border-radius: 6px; background: var(--es-green);
  color: #fff; font: inherit; font-weight: 600; padding: 7px 11px; cursor: pointer;
}
.es-primary:hover { background: var(--es-green-dark); }
.es-secondary {
  border: 1px solid var(--es-border); border-radius: 6px; background: transparent;
  color: inherit; font: inherit; padding: 6px 10px; cursor: pointer;
}
.es-secondary:hover { border-color: var(--es-green); }
.es-link { color: var(--es-chip-ink); font-size: 12px; margin-left: auto; }
.es-spacer { flex: 1; }

.es-pop button:focus-visible, .es-pop a:focus-visible, .es-pop select:focus-visible, .es-pop summary:focus-visible {
  outline: 2px solid var(--es-focus); outline-offset: 2px;
}
.es-pop button:disabled { opacity: 0.55; cursor: default; }

@media (prefers-reduced-motion: reduce) {
  .es-pop *, .es-pop *::before { animation: none !important; transition: none !important; }
}
`;

export interface QuickPopupOptions {
  readonly t: Translate;
  readonly settings: Settings;
  readonly selection: ResolvedSelection;
  /** Called after the pop-up is removed, however it was closed. */
  readonly onClose: () => void;
  /** Called when the user asks to practise; the caller opens the panel. */
  readonly onPractise: (kind: PracticeKind, accent: Accent, speed: number) => Promise<boolean>;
}

export interface QuickPopupController {
  show(): Promise<void>;
  destroy(): void;
}

/** First entry that can show a definition, preferring one with this accent. */
function pickEntry(entries: readonly DictionaryEntry[], accent: Accent): DictionaryEntry | null {
  const withAccent = entries.find((entry) =>
    entry.ipa.some((reading) => reading.accent === accent),
  );
  return withAccent ?? entries[0] ?? null;
}

function meaningFailureKey(reason: DictionaryFailure): string {
  switch (reason) {
    case "offline":
      return "popupOffline";
    case "rate-limited":
      return "popupRateLimited";
    case "not-found":
    case "bad-word":
      return "popupNotFound";
    case "server":
      return "popupServerError";
  }
}

export function createQuickPopup(
  ctx: ContentScriptContext,
  options: QuickPopupOptions,
): QuickPopupController {
  const { t, selection, settings } = options;
  const kind: PracticeKind = classifyText(selection.text);
  const tokens = tokenizeWords(selection.text);

  let accent: Accent = settings.defaultAccent;
  let speed = settings.defaultSpeed;
  let ui: ShadowUiController<{ root: HTMLElement }> | null = null;
  let speaker: Speaker | null = null;
  let releaseFocus: (() => void) | null = null;
  let stopDismissal: (() => void) | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let closed = false;

  // Data
  let dictionaryEntry: DictionaryEntry | null = null;
  let dictionaryState: "loading" | "ready" | "failed" = kind === "word" ? "loading" : "ready";
  let dictionaryFailure: DictionaryFailure | null = null;
  let cmu: IpaResult | null = null;
  const sentenceReadings = new Map<number, IpaReading | null>();
  let sentenceIpaState: "loading" | "ready" = "loading";
  let saved = false;

  // Elements
  let root: HTMLElement | null = null;
  let ipaEl: HTMLElement | null = null;
  let meaningEl: HTMLElement | null = null;
  let sentenceEl: HTMLElement | null = null;
  let sentenceIpaEl: HTMLElement | null = null;
  let listenButton: HTMLButtonElement | null = null;
  let saveButton: HTMLButtonElement | null = null;
  let statusEl: HTMLElement | null = null;
  const anchorRect: DOMRect = selection.rect;

  const close = (): void => {
    if (closed) return;
    closed = true;
    speaker?.stop();
    speaker = null;
    stopDismissal?.();
    stopDismissal = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    releaseFocus?.();
    releaseFocus = null;
    ui?.remove();
    ui = null;
    options.onClose();
  };

  /** Re-place after content changes size. */
  const place = (): void => {
    if (!ui || !root) return;
    const height = Math.min(root.offsetHeight, window.innerHeight - 16);
    const at = placeNear(anchorRect, { width: WIDTH, height }, 8, "right");
    ui.container.style.left = `${at.left}px`;
    ui.container.style.top = `${at.top}px`;
  };

  const setStatus = (text: string | null, kindOf: "ok" | "error" = "ok"): void => {
    if (!statusEl) return;
    statusEl.textContent = text ?? "";
    statusEl.className = text === null ? "es-note" : kindOf === "error" ? "es-warn" : "es-note";
  };

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  const renderIpa = (): void => {
    if (!ipaEl) return;
    ipaEl.replaceChildren();

    if (kind === "sentence") {
      const summary = sentenceIpaState === "loading" ? t("loadingIpa") : t("popupSentenceIpa");
      ipaEl.appendChild(el({ tag: "span", class: "es-note", text: summary }));
      return;
    }

    if (dictionaryState === "loading" && cmu === null) {
      ipaEl.appendChild(el({ tag: "span", class: "es-note", text: t("loadingIpa") }));
      return;
    }

    const reading = chooseReading(selection.text, accent, dictionaryEntry, cmu);
    if (!reading) {
      ipaEl.appendChild(el({ tag: "span", class: "es-note", text: t("popupNoIpa") }));
      return;
    }

    if (reading.syllables && reading.syllables.length > 0) {
      for (const syllable of reading.syllables) {
        ipaEl.appendChild(renderSyllable(syllable));
      }
    } else {
      for (const segment of stressSegments(reading.ipa)) {
        ipaEl.appendChild(
          el({
            tag: "span",
            ...(segment.stressed ? { class: "es-stress" } : {}),
            text: segment.text,
          }),
        );
      }
    }

    if (reading.source === "approximate") {
      ipaEl.appendChild(
        el({ tag: "div", class: "es-note", text: `≈ ${t("popupApproximateIpa")}` }),
      );
    }

    // Spec 5.2: never claim a UK reading we did not source.
    if (accent === "en-GB" && reading.accent === "en-US") {
      ipaEl.appendChild(
        el({ tag: "div", class: "es-note", text: t("popupUsFallback") }),
      );
    }
    if (reading.accent === "en-US" && accent === "en-GB") {
      ipaEl.appendChild(el({ tag: "span", class: "es-badge", text: "US" }));
    }
  };

  const renderSyllable = (syllable: Syllable): HTMLElement => {
    const stressed = syllable.stress === 1;
    return el({
      tag: "span",
      ...(stressed ? { class: "es-stress es-stress-dot" } : {}),
      text: syllable.ipa,
      ...(stressed ? { attrs: { title: t("popupIpaNote") } } : {}),
    });
  };

  const renderMeaning = (): void => {
    if (!meaningEl) return;
    meaningEl.replaceChildren();

    if (kind === "sentence") {
      meaningEl.hidden = true;
      return;
    }
    meaningEl.hidden = false;
    meaningEl.appendChild(
      el({ tag: "div", class: "es-section-title", text: t("popupMeaning") }),
    );

    if (dictionaryState === "loading") {
      const skeleton = el({ tag: "div", class: "es-skeleton" });
      skeleton.appendChild(el({ tag: "div", class: "es-bar" }));
      skeleton.appendChild(el({ tag: "div", class: "es-bar short" }));
      meaningEl.appendChild(el({ tag: "p", class: "es-note", text: t("popupLoadingMeaning") }));
      meaningEl.appendChild(skeleton);
      return;
    }

    if (dictionaryState === "failed" || !dictionaryEntry) {
      const key = dictionaryFailure ? meaningFailureKey(dictionaryFailure) : "popupNoDefinitions";
      meaningEl.appendChild(el({ tag: "p", class: "es-note", text: t(key) }));
      return;
    }

    const entry = dictionaryEntry;
    if (entry.definitions.length === 0) {
      meaningEl.appendChild(el({ tag: "p", class: "es-note", text: t("popupNoDefinitions") }));
      return;
    }

    meaningEl.appendChild(el({ tag: "div", class: "es-pos", text: entry.partOfSpeech }));
    const list = el({ tag: "ol", class: "es-defs" });
    for (const definition of entry.definitions.slice(0, 2)) {
      list.appendChild(el({ tag: "li", text: definition }));
    }
    meaningEl.appendChild(list);
    if (entry.example) {
      meaningEl.appendChild(
        el({ tag: "p", class: "es-example", text: `${t("popupExample")}: ${entry.example}` }),
      );
    }
  };

  const renderSentence = (): void => {
    if (!sentenceEl) return;
    if (kind !== "sentence") {
      sentenceEl.hidden = true;
      return;
    }
    sentenceEl.hidden = false;
    sentenceEl.replaceChildren();
    for (const [index, token] of tokens.entries()) {
      const span = el({ tag: "span", class: "es-word", text: token.word });
      span.dataset["index"] = String(index);
      if (index < tokens.length - 1) span.after(document.createTextNode(" "));
      sentenceEl.appendChild(span);
    }
  };

  const renderSentenceIpa = (): void => {
    if (!sentenceIpaEl || kind !== "sentence") return;
    sentenceIpaEl.replaceChildren();
    const summary = el({
      tag: "summary",
      text: sentenceIpaState === "loading" ? t("loadingIpa") : t("popupSentenceIpa"),
    });
    sentenceIpaEl.appendChild(summary);
    if (sentenceIpaState === "loading") return;

    const list = el({ tag: "ul", class: "es-word-ipa" });
    for (const [index, token] of tokens.entries()) {
      const reading = sentenceReadings.get(index);
      const item = el({ tag: "li" });
      item.appendChild(el({ tag: "span", class: "w", text: token.word }));
      item.appendChild(document.createTextNode(" "));
      item.appendChild(
        el({
          tag: "span",
          ...(reading?.source === "approximate" ? { class: "es-note" } : {}),
          text: reading
            ? `${reading.source === "approximate" ? "≈" : "/"}${reading.ipa}${reading.source === "approximate" ? "" : "/"}`
            : "—",
        }),
      );
      list.appendChild(item);
    }
    sentenceIpaEl.appendChild(list);
  };

  const highlightSentenceWord = (charIndex: number): void => {
    if (!sentenceEl || kind !== "sentence") return;
    const index = wordIndexAt(tokens, charIndex);
    for (const node of sentenceEl.querySelectorAll<HTMLElement>(".es-word")) {
      node.classList.toggle("is-active", node.dataset["index"] === String(index));
    }
  };

  const clearSentenceHighlight = (): void => {
    if (!sentenceEl) return;
    for (const node of sentenceEl.querySelectorAll<HTMLElement>(".es-word.is-active")) {
      node.classList.remove("is-active");
    }
  };

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const updateUi = (): void => {
    if (!ui) return;
    for (const button of ui.container.querySelectorAll<HTMLButtonElement>("[data-accent]")) {
      button.setAttribute("aria-pressed", String(button.dataset["accent"] === accent));
    }
    renderIpa();
    renderMeaning();
    renderSentenceIpa();
    place();
  };

  const startListen = (): void => {
    if (!listenButton) return;
    if (!speaker) {
      const source = browserSpeechSource();
      if (!source) {
        setStatus(t("errTtsUnavailable"), "error");
        return;
      }
      speaker = new Speaker({ source });
    }
    if (speaker.isSpeaking) {
      speaker.stop();
      listenButton.textContent = t("btnListen");
      ipaEl?.classList.remove("is-speaking");
      clearSentenceHighlight();
      return;
    }

    const rate = speed;
    listenButton.textContent = t("btnStop");
    ipaEl?.classList.add("is-speaking");

    const voiceName = accent === "en-GB" ? settings.voiceUk : settings.voiceUs;
    void speaker
      .speak(selection.text, {
        accent,
        rate,
        voiceName,
        onBoundary: (charIndex) => {
          if (kind === "sentence") highlightSentenceWord(charIndex);
        },
        onEnd: () => {
          if (closed) return;
          if (listenButton) listenButton.textContent = t("btnListen");
          ipaEl?.classList.remove("is-speaking");
          clearSentenceHighlight();
        },
        onError: () => {
          if (listenButton) listenButton.textContent = t("btnListen");
          ipaEl?.classList.remove("is-speaking");
          clearSentenceHighlight();
          setStatus(t("errTtsUnavailable"), "error");
        },
      });
  };

  const currentReading = (): IpaReading | null =>
    chooseReading(selection.text, accent, dictionaryEntry, cmu);

  const doSave = async (): Promise<void> => {
    if (saved || !saveButton) return;
    saveButton.disabled = true;

    const ipa =
      kind === "word"
        ? (currentReading()?.ipa ?? "")
        : joinIpa(tokens, sentenceReadings);

    try {
      await saveDraft({
        text: selection.text,
        kind,
        ipa,
        accent,
        lastResult: null,
      });
      saved = true;
      saveButton.textContent = t("btnSaved");
      setStatus(t("popupSaved"), "ok");
    } catch {
      saveButton.disabled = false;
      setStatus(t("popupSaveFailed"), "error");
    }
  };

  const doPractise = async (): Promise<void> => {
    // The caller owns the panel hand-off; keeping it outside this module means
    // the same code path serves the keyboard shortcut and context menu.
    const ok = await options.onPractise(kind, accent, speed).catch(() => false);
    if (!ok) {
      setStatus(t("popupPanelFallback"), "error");
      return;
    }
    close();
  };

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  const loadData = async (): Promise<void> => {
    if (kind === "word") {
      const [dict, ipa] = await Promise.all([
        requestDictionary(selection.text),
        requestIpa(selection.text),
      ]);
      if (closed) return;
      cmu = ipa;
      if (dict) {
        if (dict.ok) {
          dictionaryEntry = pickEntry(dict.entries, accent);
          dictionaryState = dictionaryEntry ? "ready" : "failed";
          dictionaryFailure = dictionaryEntry ? null : "not-found";
        } else {
          dictionaryState = "failed";
          dictionaryFailure = dict.reason;
        }
      } else {
        dictionaryState = "failed";
        dictionaryFailure = "offline";
      }
      updateUi();
      return;
    }

    // Sentence: per-word IPA. A sentence can be long, so lookups run together;
    // the background cache and the CMUdict reader both make each one cheap.
    const work = tokens.map(async (token, index) => {
      const ipa = await requestIpa(token.word);
      if (closed) return;
      sentenceReadings.set(index, chooseReading(token.word, accent, null, ipa));
    });
    await Promise.all(work);
    if (closed) return;
    sentenceIpaState = "ready";
    updateUi();
  };

  // -------------------------------------------------------------------------
  // Mount
  // -------------------------------------------------------------------------

  const mount = async (): Promise<void> => {
    const { mountShadowUi } = await import("../ui/shadow");
    ui = await mountShadowUi<{ root: HTMLElement }>(ctx, {
      name: "quick-popup",
      css: CSS,
      onMount: (m) => {
        const container = el({ tag: "div", class: "es-root" });
        const popup = el({ tag: "div", class: "es-pop", attrs: { role: "dialog", "aria-modal": "false" } });
        if (settings.theme === "dark") popup.classList.add("es-dark");
        if (settings.theme === "light") popup.classList.add("es-light");
        popup.setAttribute("aria-label", t("microButtonLabel"));

        const head = el({ tag: "div", class: "es-head" });
        const title = el({
          tag: "span",
          class: "es-title",
          text: selection.text,
          attrs: { title: selection.text },
        });
        const closeButton = el({
          tag: "button",
          class: "es-close",
          text: "×",
          attrs: { type: "button", "aria-label": t("btnClose") },
        }) as HTMLButtonElement;
        closeButton.addEventListener("click", close);
        head.appendChild(title);
        head.appendChild(closeButton);

        const body = el({ tag: "div", class: "es-body" });

        if (selection.text.length > 300) {
          body.appendChild(
            el({ tag: "div", class: "es-note", text: t("popupFirstSentence") }),
          );
        }

        const ipaRow = el({ tag: "div", class: "es-ipa-row" });
        ipaEl = el({ tag: "div", class: "es-ipa", attrs: { "aria-live": "polite" } });
        const accentGroup = el({
          tag: "div",
          class: "es-accent",
          attrs: { role: "group", "aria-label": t("accentLabel") },
        });
        for (const option of ["en-US", "en-GB"] as const) {
          const button = el({
            tag: "button",
            text: ACCENT_LABELS[option],
            attrs: {
              type: "button",
              "data-accent": option,
              "aria-pressed": String(option === accent),
              "aria-label": t(option === "en-US" ? "accentLongUS" : "accentLongUK"),
            },
          }) as HTMLButtonElement;
          button.addEventListener("click", () => {
            accent = option;
            updateUi();
          });
          accentGroup.appendChild(button);
        }
        ipaRow.appendChild(ipaEl);
        ipaRow.appendChild(accentGroup);
        body.appendChild(ipaRow);

        const listenRow = el({ tag: "div", class: "es-listen-row" });
        listenButton = el({
          tag: "button",
          class: "es-listen",
          text: `🔊 ${t("btnListen")}`,
          attrs: { type: "button" },
        }) as HTMLButtonElement;
        listenButton.addEventListener("click", startListen);
        listenRow.appendChild(listenButton);

        const speedWrap = el({ tag: "label", class: "es-speed", text: t("popupSpeed") });
        const speedSelect = el({
          tag: "select",
          attrs: { "aria-label": t("speedLabel") },
        }) as HTMLSelectElement;
        for (const value of SPEEDS) {
          const option = el({
            tag: "option",
            text: `${value}×`,
            attrs: { value: String(value) },
          }) as HTMLOptionElement;
          if (Math.abs(value - speed) < 0.001) option.selected = true;
          speedSelect.appendChild(option);
        }
        speedSelect.addEventListener("change", () => {
          speed = Number(speedSelect.value);
        });
        speedWrap.appendChild(speedSelect);
        listenRow.appendChild(speedWrap);
        body.appendChild(listenRow);

        if (kind === "sentence") {
          sentenceEl = el({ tag: "div", class: "es-sentence" });
          body.appendChild(sentenceEl);
        }

        meaningEl = el({ tag: "section", class: "es-meaning" });
        body.appendChild(meaningEl);

        if (kind === "sentence") {
          sentenceIpaEl = el({ tag: "details", class: "es-sentence-ipa" });
          body.appendChild(sentenceIpaEl);
        }

        const actions = el({ tag: "div", class: "es-actions" });
        const practiseButton = el({
          tag: "button",
          class: "es-primary",
          text: t("btnPractise"),
          attrs: { type: "button" },
        }) as HTMLButtonElement;
        practiseButton.addEventListener("click", () => {
          practiseButton.disabled = true;
          void doPractise().finally(() => {
            practiseButton.disabled = false;
          });
        });

        saveButton = el({
          tag: "button",
          class: "es-secondary",
          text: t("btnSave"),
          attrs: { type: "button" },
        }) as HTMLButtonElement;
        saveButton.addEventListener("click", () => {
          void doSave();
        });

        const translate = el({
          tag: "a",
          class: "es-link",
          text: t("popupTranslate"),
          attrs: {
            href: `https://translate.google.com/?sl=en&tl=fr&text=${encodeURIComponent(selection.text)}`,
            target: "_blank",
            rel: "noopener noreferrer",
          },
        });
        translate.addEventListener("click", (event) => event.stopPropagation());

        actions.appendChild(practiseButton);
        actions.appendChild(saveButton);
        actions.appendChild(translate);
        body.appendChild(actions);

        statusEl = el({ tag: "div", class: "es-note", attrs: { role: "status" } });
        body.appendChild(statusEl);

        popup.appendChild(head);
        popup.appendChild(body);
        container.appendChild(popup);
        m.container.appendChild(container);

        // The popup is non-modal, but focus must start inside it and Esc must
        // close it (spec 3, spec 4.2).
        stopDismissal = watchForDismissal(m.shadow, () => anchorRect, close, {
          onScroll: "far",
        });

        requestAnimationFrame(() => {
          if (ui) {
            releaseFocus = trapFocus(ui.container);
            place();
          }
        });

        resizeObserver = new ResizeObserver(place);
        resizeObserver.observe(popup);

        return { root: popup };
      },
    });
  };

  return {
    async show() {
      await mount();
      if (!ui) return;
      ui.mount();
      root = ui.container.querySelector<HTMLElement>(".es-pop");
      renderSentence();
      renderIpa();
      renderMeaning();
      renderSentenceIpa();
      place();

      // A late size change (font loading, meaning arriving) can leave the popup
      // hanging over the viewport edge; the ResizeObserver re-places it.
      void loadData();
    },

    destroy() {
      close();
    },
  };
}
