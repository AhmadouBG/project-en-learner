/**
 * Practise tab (spec 4.3, Phase 6 onward).
 *
 * Everything on this tab is native DOM and every visible string comes from the
 * translator. The tab owns no storage logic: saved items go through
 * `shared/saved.ts`, settings through the host, and the dictionary/CMUdict
 * through the same request helpers the pop-up uses.
 */

import { clear, el, field } from "./dom";
import type { PanelHost } from "./host";
import {
  ACCENT_LABELS,
  classifyText,
  isLookupWord,
  type Accent,
  type DictionaryEntry,
  type IpaResult,
  type PracticeTarget,
} from "../shared/messages";
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
import {
  Recorder,
  RecorderError,
  browserRecorderDependencies,
} from "../services/recorder";
import {
  browserRecognitionFactory,
  recognise,
  type RecognitionOutcome,
  type RecognitionSession,
} from "../services/recognition";
import { diffWords, type WordDiff } from "../services/diff";
import { ShadowLoop, abortableWait, type ShadowState } from "../services/shadow";
import { saveDraft } from "../shared/saved";
import type { Settings, WordCheckResult } from "../shared/storage";
import {
  makeSvgPlayIcon,
  makeSvgStopIcon,
  makeSvgRepeatIcon,
  makeSvgRecordIcon,
} from "../ui/icons";

export interface PractiseTab {
  readonly element: HTMLElement;
  setTarget(target: PracticeTarget | null): void;
  setSettings(settings: Settings): void;
  destroy(): void;
}

interface TakeState {
  readonly url: string;
  readonly durationMs: number;
  readonly diff: WordDiff | null;
  readonly recognition: RecognitionOutcome | null;
}

const IPA_DEBOUNCE_MS = 350;
const MAX_IPA_WORDS = 80;
const RECOGNITION_GRACE_MS = 4_000;



function youGlishUrl(text: string, accent: Accent): string {
  const variety = accent === "en-GB" ? "uk" : "us";
  return `https://youglish.com/pronounce/${encodeURIComponent(text.trim())}/english/${variety}`;
}

function checkResult(diff: WordDiff | null): WordCheckResult | null {
  if (!diff) return null;
  return { recognised: diff.matched, total: diff.total, ts: Date.now() };
}

/** Wait for recognition, but never leave the UI stuck if `onend` is lost. */
function settleRecognition(session: RecognitionSession): Promise<RecognitionOutcome> {
  return Promise.race([
    session.result,
    new Promise<RecognitionOutcome>((resolve) => {
      setTimeout(() => resolve({ ok: false, reason: "failed" }), RECOGNITION_GRACE_MS);
    }),
  ]);
}

export function createPractiseTab(host: PanelHost): PractiseTab {
  const t = host.t;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  let text = "";
  let accent: Accent = host.settings.defaultAccent;
  let speed = host.settings.defaultSpeed;
  let showIpa = true;

  let currentTokens = tokenizeWords("");
  let readings = new Map<number, IpaReading | null>();
  let ipaLoading = false;
  let ipaSequence = 0;
  let ipaTimer: ReturnType<typeof setTimeout> | null = null;

  let speaker: Speaker | null = null;
  let recorder: Recorder | null = null;
  let recognition: RecognitionSession | null = null;
  let takeCancelled = false;
  let take: TakeState | null = null;
  let autoSaved = false;
  let shadow: ShadowLoop | null = null;
  let abPlaying = false;
  let audio: HTMLAudioElement | null = null;
  let recordTimer: ReturnType<typeof setInterval> | null = null;
  let recordStartedAt = 0;
  let destroyed = false;

  // -------------------------------------------------------------------------
  // Elements
  // -------------------------------------------------------------------------

  const root = el({ tag: "section", class: "practise" });

  const textarea = el({
    tag: "textarea",
    class: "text-input",
    attrs: {
      id: "practice-text",
      rows: 4,
      placeholder: t("practiceTextPlaceholder"),
      "aria-label": t("practiceText"),
      spellcheck: "false",
    },
  }) as HTMLTextAreaElement;

  const accentGroup = el({
    tag: "div",
    class: "segmented",
    attrs: { role: "group", "aria-label": t("accentLabel") },
  });
  const accentButtons = new Map<Accent, HTMLButtonElement>();
  for (const option of ["en-US", "en-GB"] as const) {
    const button = el({
      tag: "button",
      class: "segment",
      text: ACCENT_LABELS[option],
      attrs: {
        type: "button",
        "aria-pressed": String(option === accent),
        "aria-label": t(option === "en-US" ? "accentLongUS" : "accentLongUK"),
      },
    }) as HTMLButtonElement;
    button.addEventListener("click", () => {
      accent = option;
      syncAccent();
      scheduleIpa();
      void host.updateSettings({ defaultAccent: option });
    });
    accentButtons.set(option, button);
    accentGroup.appendChild(button);
  }

  const speedSelect = el({
    tag: "select",
    attrs: { id: "practice-speed", "aria-label": t("speedLabel") },
  }) as HTMLSelectElement;
  for (const value of SPEEDS) {
    speedSelect.appendChild(
      el({
        tag: "option",
        text: `${value}×`,
        attrs: { value: String(value) },
      }),
    );
  }
  speedSelect.addEventListener("change", () => {
    speed = Number(speedSelect.value);
    void host.updateSettings({ defaultSpeed: speed });
  });

  const ipaToggle = el({
    tag: "button",
    class: "link-button",
    text: t("popupHideIpa"),
    attrs: { type: "button", "aria-pressed": "true" },
  }) as HTMLButtonElement;
  ipaToggle.addEventListener("click", () => {
    showIpa = !showIpa;
    ipaToggle.setAttribute("aria-pressed", String(showIpa));
    ipaToggle.textContent = showIpa ? t("popupHideIpa") : t("popupShowIpa");
    ipaBody.hidden = !showIpa;
  });

  const ipaBody = el({ tag: "div", class: "ipa-body", attrs: { "aria-live": "polite" } });
  const ipaSection = el({ tag: "section", class: "card" });
  const ipaHead = el({ tag: "div", class: "section-head" });
  ipaHead.appendChild(el({ tag: "h2", class: "section-title", text: t("ipaSectionTitle") }));
  ipaHead.appendChild(ipaToggle);
  ipaSection.appendChild(ipaHead);
  ipaSection.appendChild(ipaBody);

  const referenceStatus = el({ tag: "p", class: "status", attrs: { role: "status" } });
  const listenButton = el({
    tag: "button",
    class: "button primary",
    children: [makeSvgPlayIcon(), ` ${t("btnListen")}`],
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  const stopButton = el({
    tag: "button",
    class: "button",
    children: [makeSvgStopIcon(), ` ${t("btnStop")}`],
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  const repeatButton = el({
    tag: "button",
    class: "button",
    children: [makeSvgRepeatIcon(), ` ${t("repeatOn")}`],
    attrs: { type: "button" },
  }) as HTMLButtonElement;

  listenButton.addEventListener("click", () => {
    if (speaker?.isSpeaking) speaker.stop();
    else void speakReference();
  });
  stopButton.addEventListener("click", () => {
    speaker?.stop();
    stopTakePlayback();
  });
  repeatButton.addEventListener("click", () => {
    void speakReference();
  });

  const referenceSection = el({ tag: "section", class: "card" });
  referenceSection.appendChild(
    el({ tag: "h2", class: "section-title", text: t("btnListen") }),
  );
  const referenceRow = el({ tag: "div", class: "button-row" });
  referenceRow.append(listenButton, stopButton, repeatButton);
  referenceSection.appendChild(referenceRow);
  referenceSection.appendChild(referenceStatus);

  const youglishRow = el({ tag: "div", class: "youglish-row" });
  const youglishLink = el({
    tag: "a",
    class: "button link",
    text: t("youglish"),
    attrs: { target: "_blank", rel: "noopener noreferrer" },
  }) as HTMLAnchorElement;
  youglishRow.append(
    youglishLink,
    el({ tag: "span", class: "hint", text: t("poweredByYouglish") }),
  );
  referenceSection.appendChild(youglishRow);

  const repeatSelect = el({
    tag: "select",
    attrs: { id: "shadow-rounds", "aria-label": t("repeatCount") },
  }) as HTMLSelectElement;
  for (const value of [1, 3, 5]) {
    repeatSelect.appendChild(el({ tag: "option", text: String(value), attrs: { value: String(value) } }));
  }
  repeatSelect.value = "3";

  const gapSelect = el({
    tag: "select",
    attrs: { id: "shadow-gap", "aria-label": t("gapLength") },
  }) as HTMLSelectElement;
  for (const seconds of [0.5, 1, 1.5, 2]) {
    gapSelect.appendChild(
      el({
        tag: "option",
        text: t("gapSeconds", seconds),
        attrs: { value: String(seconds) },
      }),
    );
  }
  gapSelect.value = "1";

  const startShadowButton = el({
    tag: "button",
    class: "button primary",
    children: [makeSvgPlayIcon(), ` ${t("btnStartShadowing")}`],
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  const cancelShadowButton = el({
    tag: "button",
    class: "button",
    children: [makeSvgStopIcon(), ` ${t("btnCancelShadowing")}`],
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  cancelShadowButton.hidden = true;
  const shadowStatus = el({ tag: "p", class: "status", attrs: { role: "status" } });

  startShadowButton.addEventListener("click", () => startShadowing());
  cancelShadowButton.addEventListener("click", () => cancelShadowing());

  const shadowSection = el({ tag: "section", class: "card" });
  shadowSection.appendChild(
    el({ tag: "h2", class: "section-title", text: t("shadowSectionTitle") }),
  );
  const shadowFields = el({ tag: "div", class: "field-row" });
  shadowFields.append(field(t("repeatCount"), repeatSelect), field(t("gapLength"), gapSelect));
  shadowSection.append(shadowFields, startShadowButton, cancelShadowButton, shadowStatus);

  const recordStatus = el({ tag: "p", class: "status", attrs: { role: "status" } });
  const recordButton = el({
    tag: "button",
    class: "button danger",
    children: [makeSvgRecordIcon(), ` ${t("btnRecord")}`],
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  const playTakeButton = el({
    tag: "button",
    class: "button",
    children: [makeSvgPlayIcon(), ` ${t("playMyTake")}`],
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  const abButton = el({
    tag: "button",
    class: "button",
    text: t("abCompare"),
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  const discardButton = el({
    tag: "button",
    class: "button",
    text: t("btnDiscard"),
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  const micHelperButton = el({
    tag: "button",
    class: "link-button",
    text: t("btnAllowMic"),
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  micHelperButton.hidden = true;

  micHelperButton.addEventListener("click", () => {
    void chrome.tabs
      .create({ url: chrome.runtime.getURL("permission.html") })
      .catch(() => undefined);
  });

  const meter = el({ tag: "div", class: "level-meter", attrs: { "aria-hidden": "true" } });
  const meterFill = el({ tag: "span" });
  meter.appendChild(meterFill);

  const waveform = el({
    tag: "canvas",
    class: "waveform",
    attrs: { width: 520, height: 64, "aria-hidden": "true" },
  }) as HTMLCanvasElement;

  recordButton.addEventListener("click", () => {
    if (recorder) void stopTake();
    else void beginTake();
  });
  playTakeButton.addEventListener("click", () => playTake());
  abButton.addEventListener("click", () => void compareAB());
  discardButton.addEventListener("click", () => discardTake());

  const recordSection = el({ tag: "section", class: "card" });
  recordSection.appendChild(
    el({ tag: "h2", class: "section-title", text: t("recordSectionTitle") }),
  );
  recordSection.append(
    el({ tag: "p", class: "hint", text: t("micExplanation") }),
    el({ tag: "p", class: "hint warn", text: t("micPrivacyNote") }),
    meter,
    waveform,
  );
  recordSection.appendChild(el({ tag: "p", class: "hint", text: t("autoStopNote") }));
  const recordRow = el({ tag: "div", class: "button-row" });
  recordRow.append(recordButton, playTakeButton, abButton, discardButton);
  recordSection.append(recordRow, micHelperButton, recordStatus);

  const resultBody = el({ tag: "div", class: "result-body", attrs: { "aria-live": "polite" } });
  const resultSection = el({ tag: "section", class: "card" });
  resultSection.appendChild(
    el({ tag: "h2", class: "section-title", text: t("resultTitle") }),
  );
  resultSection.appendChild(resultBody);

  const saveButton = el({
    tag: "button",
    class: "button primary wide",
    text: t("btnSave"),
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  saveButton.addEventListener("click", () => {
    saveButton.disabled = true;
    void saveCurrent()
      .then(() => {
        saveButton.textContent = t("btnSaved");
        window.setTimeout(() => {
          if (!destroyed) saveButton.textContent = t("btnSave");
        }, 1_800);
      })
      .finally(() => {
        if (!destroyed) saveButton.disabled = false;
      });
  });

  root.append(
    field(t("practiceText"), textarea),
    field(t("accentLabel"), accentGroup),
    field(t("speedLabel"), speedSelect),
    ipaSection,
    referenceSection,
    shadowSection,
    recordSection,
    resultSection,
    saveButton,
    el({ tag: "p", class: "hint", text: t("autoSaveNote") }),
  );

  // -------------------------------------------------------------------------
  // IPA breakdown
  // -------------------------------------------------------------------------

  const syncAccent = (): void => {
    for (const [option, button] of accentButtons) {
      button.setAttribute("aria-pressed", String(option === accent));
    }
  };

  const syncControls = (): void => {
    textarea.value = text;
    speedSelect.value = String(speed);
    syncAccent();
    repeatSelect.value = repeatSelect.value || "3";
    updateYouGlish();
  };

  const updateYouGlish = (): void => {
    const tokens = tokenizeWords(text);
    const shortEnough = tokens.length > 0 && tokens.length <= 5;
    youglishRow.hidden = !shortEnough;
    if (shortEnough) youglishLink.href = youGlishUrl(text, accent);
  };

  const renderIpa = (): void => {
    clear(ipaBody);
    if (!showIpa) return;

    if (text.trim() === "") {
      ipaBody.appendChild(el({ tag: "p", class: "hint", text: t("noTextToPractise") }));
      return;
    }
    if (ipaLoading && readings.size === 0) {
      ipaBody.appendChild(el({ tag: "p", class: "hint", text: t("loadingIpa") }));
      return;
    }

    const list = el({ tag: "div", class: "ipa-words" });
    for (const [index, token] of currentTokens.entries()) {
      const reading = readings.get(index);
      const item = el({ tag: "span", class: "ipa-word" });
      item.dataset["index"] = String(index);
      item.appendChild(el({ tag: "span", class: "ipa-word-text", text: token.word }));

      const ipa = el({ tag: "span", class: "ipa-word-ipa" });
      if (!reading) {
        ipa.textContent = "—";
      } else if (reading.syllables && reading.syllables.length > 0) {
        for (const syllable of reading.syllables) {
          ipa.appendChild(
            el({
              tag: "span",
              ...(syllable.stress === 1 ? { class: "stress" } : {}),
              text: syllable.ipa,
            }),
          );
        }
      } else {
        for (const segment of stressSegments(reading.ipa)) {
          ipa.appendChild(
            el({
              tag: "span",
              ...(segment.stressed ? { class: "stress" } : {}),
              text: segment.text,
            }),
          );
        }
      }
      if (reading?.source === "approximate") {
        ipa.appendChild(el({ tag: "span", class: "badge", text: "≈" }));
      }
      if (accent === "en-GB" && reading?.accent === "en-US") {
        ipa.appendChild(el({ tag: "span", class: "badge", text: "US" }));
      }
      item.appendChild(ipa);
      list.appendChild(item);
    }
    ipaBody.appendChild(list);
  };

  const loadIpa = async (): Promise<void> => {
    const sequence = ++ipaSequence;
    const tokens = tokenizeWords(text);
    currentTokens = tokens;
    if (tokens.length === 0) {
      readings = new Map();
      ipaLoading = false;
      renderIpa();
      return;
    }

    ipaLoading = true;
    renderIpa();
    const unique = [...new Set(tokens.map((token) => token.word.toLowerCase()))]
      .filter((word) => isLookupWord(word))
      .slice(0, MAX_IPA_WORDS);

    const [cmuResults, dictionaryResults] = await Promise.all([
      Promise.all(unique.map(async (word) => [word, await requestIpa(word)] as const)),
      accent === "en-GB"
        ? Promise.all(
          unique.map(async (word) => [word, await requestDictionary(word)] as const),
        )
        : Promise.resolve([] as (readonly [string, Awaited<ReturnType<typeof requestDictionary>>])[]),
    ]);

    if (destroyed || sequence !== ipaSequence) return;

    const cmu = new Map<string, IpaResult | null>(cmuResults);
    const dictionary = new Map<string, DictionaryEntry | null>();
    for (const [word, result] of dictionaryResults) {
      if (result?.ok) dictionary.set(word, result.entries[0] ?? null);
    }

    readings = new Map(
      tokens.map((token, index) => {
        const key = token.word.toLowerCase();
        return [index, chooseReading(token.word, accent, dictionary.get(key) ?? null, cmu.get(key) ?? null)] as const;
      }),
    );
    ipaLoading = false;
    renderIpa();
  };

  const scheduleIpa = (): void => {
    if (ipaTimer !== null) clearTimeout(ipaTimer);
    ipaTimer = setTimeout(() => {
      ipaTimer = null;
      void loadIpa();
    }, IPA_DEBOUNCE_MS);
  };

  textarea.addEventListener("input", () => {
    text = textarea.value;
    updateYouGlish();
    if (!recorder) {
      discardTake();
    }
    scheduleIpa();
  });

  // -------------------------------------------------------------------------
  // Reference playback
  // -------------------------------------------------------------------------

  const highlightWord = (charIndex: number): void => {
    const index = wordIndexAt(currentTokens, charIndex);
    for (const node of ipaBody.querySelectorAll<HTMLElement>(".ipa-word")) {
      node.classList.toggle("is-speaking", node.dataset["index"] === String(index));
    }
  };

  const clearHighlight = (): void => {
    for (const node of ipaBody.querySelectorAll<HTMLElement>(".ipa-word.is-speaking")) {
      node.classList.remove("is-speaking");
    }
  };

  const ensureSpeaker = (): Speaker | null => {
    if (speaker) return speaker;
    const source = browserSpeechSource();
    if (!source) {
      referenceStatus.textContent = t("errTtsUnavailable");
      return null;
    }
    speaker = new Speaker({ source });
    return speaker;
  };

  const speakReference = async (signal?: AbortSignal): Promise<void> => {
    const value = text.trim();
    if (value === "") {
      referenceStatus.textContent = t("errNoText");
      return;
    }
    const engine = ensureSpeaker();
    if (!engine) return;

    referenceStatus.textContent = t("preparingListening");
    clearHighlight();
    const onAbort = (): void => engine.stop();
    signal?.addEventListener("abort", onAbort, { once: true });

    await engine.speak(value, {
      accent,
      rate: speed,
      voiceName: accent === "en-GB" ? host.settings.voiceUk : host.settings.voiceUs,
      onBoundary: (index) => highlightWord(index),
      onEnd: () => {
        clearHighlight();
        if (!destroyed) referenceStatus.textContent = "";
      },
      onError: () => {
        clearHighlight();
        if (!destroyed) referenceStatus.textContent = t("errTtsUnavailable");
      },
    });

    signal?.removeEventListener("abort", onAbort);
  };

  // -------------------------------------------------------------------------
  // Takes, recognition and the result block
  // -------------------------------------------------------------------------

  const stopTakePlayback = (): void => {
    abPlaying = false;
    if (audio) {
      audio.pause();
      audio.onended = null;
      audio = null;
    }
  };

  const drawWaveform = (peaks: readonly number[]): void => {
    const context = waveform.getContext("2d");
    if (!context) return;
    const { width, height } = waveform;
    context.clearRect(0, 0, width, height);
    const styles = getComputedStyle(document.documentElement);
    const color = styles.getPropertyValue("--es-green").trim() || "#4caf50";
    context.fillStyle = color;

    const slot = width / Math.max(1, peaks.length);
    for (const [index, peak] of peaks.entries()) {
      const bar = Math.max(1, Math.min(1, peak) * (height - 6));
      context.fillRect(index * slot + 1, (height - bar) / 2, Math.max(1, slot - 2), bar);
    }
  };

  const setMeter = (level: number): void => {
    meterFill.style.transform = `scaleX(${Math.min(1, Math.max(0, level))})`;
  };

  const updateRecordTimer = (): void => {
    if (!recorder || recordStartedAt === 0) return;
    const seconds = (Date.now() - recordStartedAt) / 1_000;
    recordStatus.textContent = `${t("recordingNow")} ${seconds.toFixed(1)} s`;
  };

  const stopTake = async (): Promise<void> => {
    if (!recorder) return;
    recordButton.disabled = true;
    await recorder.stop("user").catch(() => undefined);
  };

  const abortTake = (): void => {
    takeCancelled = true;
    recognition?.abort();
    recorder?.abort();
  };

  const resetRecordUi = (): void => {
    if (recordTimer !== null) {
      clearInterval(recordTimer);
      recordTimer = null;
    }
    recordStartedAt = 0;
    recordButton.replaceChildren(makeSvgRecordIcon(), ` ${t("btnRecord")}`);
    recordButton.disabled = false;
    playTakeButton.disabled = take === null;
    abButton.disabled = take === null;
    discardButton.disabled = take === null;
    micHelperButton.hidden = true;
    setMeter(0);
  };

  const beginTake = async (signal?: AbortSignal): Promise<void> => {
    if (recorder || destroyed) return;
    if (!browserRecorderDependencies()) {
      recordStatus.textContent = t("errRecordingFailed");
      return;
    }

    takeCancelled = false;
    recognition = null;
    if (host.settings.checkWordsAfterRecording) {
      const factory = browserRecognitionFactory();
      if (factory) recognition = recognise(factory, { lang: accent });
    }

    const engine = new Recorder({
      onLevel: (level, peaks) => {
        setMeter(level);
        drawWaveform(peaks);
      },
    });
    recorder = engine;
    recordStatus.textContent = t("preparingListening");
    micHelperButton.hidden = true;

    const onAbort = (): void => abortTake();
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await engine.start();
    } catch (error) {
      const reason = error instanceof RecorderError ? error.reason : "failed";
      recorder = null;
      recognition?.abort();
      recognition = null;
      signal?.removeEventListener("abort", onAbort);
      recordStatus.textContent =
        reason === "denied"
          ? t("errMicDenied")
          : reason === "unsupported"
            ? t("errRecordingFailed")
            : reason === "unavailable"
              ? t("errMicUnavailable")
              : t("errRecordingFailed");
      micHelperButton.hidden = reason !== "denied";
      return;
    }

    recordStartedAt = Date.now();
    recordButton.replaceChildren(makeSvgStopIcon(), ` ${t("btnStopRecording")}`);
    playTakeButton.disabled = true;
    abButton.disabled = true;
    discardButton.disabled = true;
    recordStatus.textContent = t("recordingNow");
    recordTimer = setInterval(updateRecordTimer, 200);

    const outcome = await engine.result;
    recognition?.stop();
    signal?.removeEventListener("abort", onAbort);

    const spoken = recognition ? await settleRecognition(recognition) : null;
    recognition = null;
    recorder = null;

    if (takeCancelled) {
      resetRecordUi();
      recordStatus.textContent = "";
      return;
    }

    if (!outcome.ok) {
      resetRecordUi();
      recordStatus.textContent =
        outcome.reason === "denied" ? t("errMicDenied") : t("errRecordingFailed");
      micHelperButton.hidden = outcome.reason !== "denied";
      return;
    }

    const url = URL.createObjectURL(outcome.take.blob);
    if (take) URL.revokeObjectURL(take.url);
    const diff = spoken?.ok ? diffWords(text, spoken.transcript) : null;
    take = { url, durationMs: outcome.take.durationMs, diff, recognition: spoken };
    audio = null;

    resetRecordUi();
    drawWaveform([]);
    recordStatus.textContent =
      outcome.stoppedBy === "silence" ? t("autoStopNote") : "";
    renderResult();

    if (
      host.settings.autoSaveAfterFirstRecording &&
      !autoSaved &&
      text.trim() !== ""
    ) {
      autoSaved = true;
      await saveCurrent(checkResult(diff), true);
    }
  };

  const playTake = (): void => {
    if (!take) return;
    stopTakePlayback();
    audio = new Audio(take.url);
    audio.onended = () => {
      audio = null;
    };
    void audio.play().catch(() => {
      recordStatus.textContent = t("errRecordingFailed");
    });
  };

  const compareAB = async (): Promise<void> => {
    if (!take) return;
    if (abPlaying) {
      stopTakePlayback();
      speaker?.stop();
      return;
    }
    abPlaying = true;
    abButton.textContent = t("btnStop");
    await speakReference();
    if (abPlaying) {
      playTake();
      // Wait for the take to finish before re-enabling the control.
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!abPlaying || audio === null) {
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
    }
    abPlaying = false;
    abButton.textContent = t("abCompare");
  };

  const discardTake = (): void => {
    stopTakePlayback();
    if (take) URL.revokeObjectURL(take.url);
    take = null;
    renderResult();
    resetRecordUi();
  };

  const renderResult = (): void => {
    clear(resultBody);
    if (!take) {
      resultBody.appendChild(el({ tag: "p", class: "hint", text: t("noTakeYet") }));
      return;
    }
    if (!take.diff) {
      resultBody.appendChild(
        el({
          tag: "p",
          class: "hint",
          text: take.recognition?.ok
            ? t("resultNote")
            : t("checkWordsUnsupported"),
        }),
      );
      return;
    }

    const diff = take.diff;
    resultBody.appendChild(
      el({
        tag: "p",
        class: "result-count",
        text: t("wordsRecognised", diff.matched, diff.total),
      }),
    );

    const words = el({ tag: "p", class: "result-words" });
    for (const word of diff.words) {
      words.appendChild(
        el({
          tag: "span",
          class: `result-word ${word.status}`,
          text: word.word,
          attrs:
            word.status === "matched"
              ? { title: t("matchedWord") }
              : word.status === "missing"
                ? { title: t("missedWord") }
                : word.status === "substituted"
                  ? {
                    title: `${t("replacedWord")}: ${word.heard ?? ""}`,
                  }
                  : { title: t("extraWord") },
        }),
      );
    }
    resultBody.appendChild(words);

    if (diff.transcript !== "") {
      resultBody.appendChild(
        el({
          tag: "p",
          class: "hint",
          text: `${t("transcriptLabel")}: ${diff.transcript}`,
        }),
      );
    }
    resultBody.appendChild(el({ tag: "p", class: "hint", text: t("resultNote") }));
  };

  // -------------------------------------------------------------------------
  // Shadow loop
  // -------------------------------------------------------------------------

  const setShadowUi = (state: ShadowState, round: number, countdown?: number): void => {
    const rounds = Number(repeatSelect.value);
    switch (state) {
      case "idle":
        shadowStatus.textContent = "";
        startShadowButton.disabled = false;
        cancelShadowButton.hidden = true;
        break;
      case "playing":
        shadowStatus.textContent = `${t("roundOf", round, rounds)} · ${t("preparingListening")}`;
        startShadowButton.disabled = true;
        cancelShadowButton.hidden = false;
        break;
      case "countdown":
        shadowStatus.textContent = `${t("roundOf", round, rounds)} · ${t("countdown", countdown ?? 1)}`;
        break;
      case "recording":
        shadowStatus.textContent = `${t("roundOf", round, rounds)} · ${t("recordingNow")}`;
        break;
      case "review":
        shadowStatus.textContent = `${t("roundOf", round, rounds)} · ${t("reviewTake")}`;
        break;
      case "done":
        shadowStatus.textContent = t("shadowingDone");
        startShadowButton.disabled = false;
        cancelShadowButton.hidden = true;
        break;
    }
  };

  const startShadowing = (): void => {
    if (shadow || text.trim() === "") {
      if (text.trim() === "") referenceStatus.textContent = t("errNoText");
      return;
    }

    const loop = new ShadowLoop(
      {
        playReference: async (_round, signal) => {
          await speakReference(signal);
        },
        record: async (_round, signal) => {
          if (signal.aborted) return;
          await beginTake(signal);
        },
        wait: abortableWait,
        onState: (state, round, countdown) => {
          setShadowUi(state, round, countdown);
        },
      },
      {
        rounds: Number(repeatSelect.value),
        gapMs: Number(gapSelect.value) * 1_000,
        countdownMs: 800,
      },
    );
    shadow = loop;

    void loop.start().then((finished) => {
      if (destroyed) return;
      shadow = null;
      setShadowUi(finished ? "done" : "idle", loop.round);
    });
  };

  const cancelShadowing = (): void => {
    shadow?.cancel();
    shadow = null;
    speaker?.stop();
    abortTake();
    resetRecordUi();
    setShadowUi("idle", 1);
  };

  // -------------------------------------------------------------------------
  // Save + settings
  // -------------------------------------------------------------------------

  const currentIpa = (): string => joinIpa(currentTokens, readings);

  const saveCurrent = async (
    result: WordCheckResult | null = null,
    automatic = false,
  ): Promise<void> => {
    const value = text.trim();
    if (value === "") {
      host.toast(t("errNoText"));
      return;
    }
    try {
      await saveDraft({
        text: value,
        kind: classifyText(value),
        ipa: currentIpa(),
        accent,
        lastResult: result,
      });
      if (!automatic) host.toast(t("savedToast"));
    } catch {
      host.toast(t("errQuota"));
    }
  };

  const applySettings = (settings: Settings): void => {
    accent = settings.defaultAccent;
    speed = settings.defaultSpeed;
    syncControls();
    updateYouGlish();
    scheduleIpa();
  };

  const setTarget = (target: PracticeTarget | null): void => {
    if (!target) return;
    text = target.text;
    accent = target.accent;
    speed = target.speed;
    syncControls();
    updateYouGlish();
    void loadIpa();
    textarea.focus();
  };

  // Initial paint.
  syncControls();
  renderResult();
  void loadIpa();

  return {
    element: root,
    setTarget,
    setSettings: applySettings,
    destroy() {
      destroyed = true;
      if (ipaTimer !== null) clearTimeout(ipaTimer);
      speaker?.stop();
      recorder?.abort();
      recognition?.abort();
      shadow?.cancel();
      stopTakePlayback();
      if (take) URL.revokeObjectURL(take.url);
      if (recordTimer !== null) clearInterval(recordTimer);
    },
  };
}
