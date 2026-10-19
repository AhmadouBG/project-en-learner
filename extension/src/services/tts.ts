/**
 * Text-to-speech (spec 5.4).
 *
 * Wraps `speechSynthesis` with the three things the spec requires:
 *  - accent-aware voice selection (`en-US` / `en-GB`), never by hardcoded name;
 *  - speed control via `rate`;
 *  - long-text chunking, because Chrome can stop speaking at ~15 s;
 *  - `boundary` events for word highlighting, with a timer fallback for the
 *    voices that never emit them.
 *
 * The DOM type surface is narrow and injected, so this module is unit-tested
 * against a fake synthesiser on Node (spec 9). No user text is ever logged.
 */

import type { Accent } from "../shared/messages";

/** Voices load asynchronously in Chrome, so callers must cope with an empty list. */
export interface VoiceLike {
  readonly name: string;
  readonly lang: string;
  readonly default?: boolean;
  readonly localService?: boolean;
}

/** The small slice of `SpeechSynthesisUtterance` this module needs. */
export interface UtteranceLike {
  text: string;
  lang: string;
  rate: number;
  voice: VoiceLike | null;
  onboundary: ((event: { charIndex: number }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}

/** The small slice of `speechSynthesis` this module needs. */
export interface SynthLike {
  getVoices(): readonly VoiceLike[];
  speak(utterance: UtteranceLike): void;
  cancel(): void;
}

export interface SpeechSource {
  readonly synth: SynthLike;
  createUtterance(text: string): UtteranceLike;
  /** Fires when the OS reports a changed voice set. */
  onVoicesChanged?(listener: () => void): () => void;
}

/** Build the real browser source. Only valid in an extension page. */
export function browserSpeechSource(): SpeechSource | null {
  if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") {
    return null;
  }
  const synth = window.speechSynthesis;
  return {
    synth: {
      getVoices: () => synth.getVoices(),
      speak: (utterance) => synth.speak(utterance as SpeechSynthesisUtterance),
      cancel: () => synth.cancel(),
    },
    createUtterance: (text) => createBrowserUtterance(text),
    onVoicesChanged: (listener) => {
      synth.addEventListener("voiceschanged", listener);
      return () => synth.removeEventListener("voiceschanged", listener);
    },
  };
}

/**
 * Adapt the real `SpeechSynthesisUtterance` to the narrow interface above.
 *
 * The DOM properties are writable and typed with the full `SpeechSynthesisEvent`
 * / `SpeechSynthesisVoice` shapes, which are not assignable to our narrower
 * test-facing interface. An explicit adapter keeps the cast in one place and
 * lets the boundary handler receive only `charIndex`.
 */
function createBrowserUtterance(text: string): UtteranceLike {
  const utterance = new SpeechSynthesisUtterance(text);
  let boundary: ((event: { charIndex: number }) => void) | null = null;
  let end: (() => void) | null = null;
  let error: ((event: { error: string }) => void) | null = null;

  utterance.addEventListener("boundary", (event) => {
    boundary?.({ charIndex: event.charIndex });
  });
  utterance.addEventListener("end", () => {
    end?.();
  });
  utterance.addEventListener("error", (event) => {
    error?.({ error: event.error });
  });

  return {
    get text() {
      return utterance.text;
    },
    set text(value: string) {
      utterance.text = value;
    },
    get lang() {
      return utterance.lang;
    },
    set lang(value: string) {
      utterance.lang = value;
    },
    get rate() {
      return utterance.rate;
    },
    set rate(value: number) {
      utterance.rate = value;
    },
    get voice(): VoiceLike | null {
      return utterance.voice;
    },
    set voice(value: VoiceLike | null) {
      utterance.voice = value as SpeechSynthesisVoice | null;
    },
    get onboundary() {
      return boundary;
    },
    set onboundary(value: ((event: { charIndex: number }) => void) | null) {
      boundary = value;
    },
    get onend() {
      return end;
    },
    set onend(value: (() => void) | null) {
      end = value;
    },
    get onerror() {
      return error;
    },
    set onerror(value: ((event: { error: string }) => void) | null) {
      error = value;
    },
  };
}

// ---------------------------------------------------------------------------
// Voice selection
// ---------------------------------------------------------------------------

/** Normalise a BCP-47 tag for comparison: `en-US` and `en_US` are the same. */
function normaliseLang(lang: string): string {
  return lang.replace("_", "-").toLowerCase();
}

/**
 * Choose the best voice for an accent.
 *
 * Order of preference:
 *  1. a voice the user explicitly picked (stored in Settings), if still present;
 *  2. an exact `en-US` / `en-GB` match, preferring local, then default;
 *  3. any voice whose language starts with the accent (`en-US-x`), same rules;
 *  4. `null`, which lets the browser use its own default with `lang` set.
 *
 * Voice names differ per OS, so nothing here names a voice.
 */
export function chooseVoice(
  voices: readonly VoiceLike[],
  accent: Accent,
  preferredName?: string | null,
): VoiceLike | null {
  if (voices.length === 0) return null;

  if (preferredName) {
    const preferred = voices.find((voice) => voice.name === preferredName);
    if (preferred) return preferred;
  }

  const wanted = normaliseLang(accent);
  const rank = (voice: VoiceLike): number => {
    const lang = normaliseLang(voice.lang);
    const exact = lang === wanted ? 0 : lang.startsWith(`${wanted}-`) ? 1 : 2;
    const local = voice.localService === false ? 1 : 0;
    const isDefault = voice.default === true ? 0 : 1;
    return exact * 100 + local * 10 + isDefault;
  };

  const candidates = voices
    .filter((voice) => normaliseLang(voice.lang).startsWith("en"))
    .sort((a, b) => rank(a) - rank(b));

  const best = candidates[0];
  if (!best) return null;
  // Do not hand back an unrelated English variant as if it were the requested
  // accent. The browser's own default is a better fallback than a mislabelled
  // Australian voice.
  const bestLang = normaliseLang(best.lang);
  if (!bestLang.startsWith(wanted)) return null;
  return best;
}

/** Voices usable for an accent, for the Settings picker. */
export function voicesForAccent(voices: readonly VoiceLike[], accent: Accent): VoiceLike[] {
  const wanted = normaliseLang(accent);
  return voices.filter((voice) => normaliseLang(voice.lang).startsWith(wanted));
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** Chrome's ~15 s cut-off is avoided by keeping each utterance short. */
export const MAX_CHUNK_CHARS = 160;

export interface TextChunk {
  readonly text: string;
  /** Character offset of this chunk in the original string. */
  readonly offset: number;
}

/**
 * Split text into speakable chunks at word boundaries.
 *
 * A chunk never exceeds `maxChars` unless a single token is longer than that, in
 * which case the token is hard-split (a URL or a very long compound word).
 * Offsets are preserved so boundary events can be mapped back to the full text.
 */
export function splitIntoChunks(text: string, maxChars = MAX_CHUNK_CHARS): TextChunk[] {
  const chunks: TextChunk[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    // Skip leading whitespace so a chunk never begins with a space.
    while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
    if (cursor >= text.length) break;

    const chunkStart = cursor;
    let lastBreak = -1;

    while (cursor < text.length && cursor - chunkStart < maxChars) {
      const char = text[cursor] ?? "";
      cursor += 1;
      if (/\s/.test(char)) lastBreak = cursor;
    }

    let end = cursor;
    if (cursor < text.length && lastBreak > chunkStart) {
      end = lastBreak;
      cursor = lastBreak;
    }

    const chunkText = text.slice(chunkStart, end).trim();
    if (chunkText !== "") chunks.push({ text: chunkText, offset: chunkStart });
  }

  return chunks;
}

/** Flatten chunks back into a normalised string, for tests and callers. */
export function chunksToText(chunks: readonly TextChunk[]): string {
  return chunks.map((chunk) => chunk.text).join(" ");
}

// ---------------------------------------------------------------------------
// Speaker
// ---------------------------------------------------------------------------

export interface SpeakerOptions {
  readonly source: SpeechSource;
  /** Injectable timers, so tests drive playback synchronously. */
  readonly setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface SpeakOptions {
  readonly accent: Accent;
  readonly rate?: number;
  /** Settings voice name, if the user picked one. */
  readonly voiceName?: string | null;
  /** Absolute character index of the word currently spoken. */
  readonly onBoundary?: (charIndex: number) => void;
  readonly onStart?: () => void;
  readonly onEnd?: () => void;
  readonly onError?: (reason: "unsupported" | "failed") => void;
}

/**
 * A single speaking session.
 *
 * One instance owns the synthesiser: `speak()` cancels whatever was playing
 * first, which is what prevents overlapping audio in the shadowing loop
 * (spec Phase 9 acceptance).
 */
export class Speaker {
  private readonly source: SpeechSource;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (handle: ReturnType<typeof setTimeout>) => void;

  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private token = 0;
  private speaking = false;
  /** Resolves the in-flight `speak()` promise, so `stop()` never leaves it hanging. */
  private settleCurrent: (() => void) | null = null;

  constructor(options: SpeakerOptions) {
    this.source = options.source;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  getVoices(): readonly VoiceLike[] {
    return this.source.synth.getVoices();
  }

  onVoicesChanged(listener: () => void): () => void {
    return this.source.onVoicesChanged?.(listener) ?? (() => undefined);
  }

  /**
   * Speak `text`, resolving when playback finishes, fails, or is cancelled.
   *
   * Resolving on cancel matters for the state machine: a cancelled round must
   * not leave an awaited promise hanging.
   */
  speak(text: string, options: SpeakOptions): Promise<void> {
    this.stop();

    const trimmed = text.trim();
    if (trimmed === "") {
      options.onEnd?.();
      return Promise.resolve();
    }

    const accent: Accent = options.accent;
    const rate = clampRate(options.rate ?? 1);
    const chunks = splitIntoChunks(trimmed);
    const session = ++this.token;
    this.speaking = true;

    return new Promise<void>((resolve) => {
      let index = 0;
      let settled = false;
      /** Chosen once voices are available; `null` lets the browser default apply. */
      let voice: VoiceLike | null = null;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (session === this.token) this.speaking = false;
        if (this.settleCurrent === finish) this.settleCurrent = null;
        this.clearAll();
        resolve();
      };

      this.settleCurrent = finish;

      const next = (): void => {
        if (session !== this.token) {
          finish();
          return;
        }
        const chunk = chunks[index];
        if (!chunk) {
          options.onEnd?.();
          finish();
          return;
        }
        index += 1;

        const utterance = this.source.createUtterance(chunk.text);
        utterance.lang = accent;
        utterance.rate = rate;
        utterance.voice = voice;

        let boundarySeen = false;
        let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
        let watchdog: ReturnType<typeof setTimeout> | null = null;

        const clearChunkTimers = (): void => {
          if (fallbackTimer !== null) {
            this.clearTimer(fallbackTimer);
            this.timers.delete(fallbackTimer);
            fallbackTimer = null;
          }
          if (watchdog !== null) {
            this.clearTimer(watchdog);
            this.timers.delete(watchdog);
            watchdog = null;
          }
        };

        utterance.onboundary = (event) => {
          boundarySeen = true;
          options.onBoundary?.(chunk.offset + Math.max(0, event.charIndex));
        };

        utterance.onend = () => {
          clearChunkTimers();
          next();
        };

        utterance.onerror = (event) => {
          clearChunkTimers();
          // `interrupted` / `canceled` mean stop() did its job, not a failure.
          if (event.error === "interrupted" || event.error === "canceled") {
            finish();
            return;
          }
          options.onError?.("failed");
          finish();
        };

        // Timer fallback: some voices never emit boundary events. Advance the
        // highlight at the average English speaking rate (~14 chars/s) so the
        // UI still tracks the audio reasonably.
        const estimatedMs = Math.max(600, (chunk.text.length / (14 * rate)) * 1000);
        const startAt = Date.now();
        let lastReported = -1;
        const tick = (): void => {
          if (session !== this.token || boundarySeen) return;
          const elapsed = Date.now() - startAt;
          const approx = Math.min(
            chunk.text.length - 1,
            Math.floor((elapsed / estimatedMs) * chunk.text.length),
          );
          if (approx !== lastReported && approx >= 0) {
            lastReported = approx;
            options.onBoundary?.(chunk.offset + approx);
          }
          fallbackTimer = this.setTimer(tick, 180);
          this.timers.add(fallbackTimer);
        };
        fallbackTimer = this.setTimer(tick, 220);
        this.timers.add(fallbackTimer);

        // Chrome's 15 s cut-off workaround: if `onend` never arrives, cancel
        // this chunk and continue. The margin is deliberately generous.
        watchdog = this.setTimer(() => {
          if (session !== this.token) return;
          this.source.synth.cancel();
          clearChunkTimers();
          next();
        }, Math.max(5_000, estimatedMs + 3_000));
        this.timers.add(watchdog);

        try {
          if (!this.speaking) {
            finish();
            return;
          }
          this.source.synth.speak(utterance);
        } catch {
          clearChunkTimers();
          options.onError?.("unsupported");
          finish();
        }
      };

      const start = (): void => {
        const voices = this.getVoices();
        if (voices.length > 0) {
          voice = chooseVoice(voices, accent, options.voiceName ?? null);
          options.onStart?.();
          next();
          return;
        }

        // Chrome loads the voice list asynchronously, so an empty list right
        // after startup is normal. Wait for it, but never hang: if no voice is
        // installed at all, `speechSynthesis.speak` plays nothing and fires no
        // event, which used to leave the user with silent UI. Report it instead.
        let resolved = false;
        let unsubscribe: () => void = () => undefined;
        const settle = (): void => {
          if (resolved) return;
          resolved = true;
          unsubscribe();
          this.clearTimer(pollTimer);
          this.timers.delete(pollTimer);
          this.clearTimer(giveUpTimer);
          this.timers.delete(giveUpTimer);

          if (session !== this.token) {
            finish();
            return;
          }
          const loaded = this.getVoices();
          if (loaded.length === 0) {
            options.onError?.("unsupported");
            finish();
            return;
          }
          voice = chooseVoice(loaded, accent, options.voiceName ?? null);
          options.onStart?.();
          next();
        };

        // Most browsers never fire `voiceschanged`; a short poll covers them.
        const pollTimer = this.setTimer(settle, 150);
        const giveUpTimer = this.setTimer(settle, VOICE_WAIT_MS);
        this.timers.add(pollTimer);
        this.timers.add(giveUpTimer);
        unsubscribe = this.onVoicesChanged(() => settle());
      };

      start();
    });
  }

  /** Cancel playback. Safe to call repeatedly. */
  stop(): void {
    this.token += 1;
    this.speaking = false;
    const settle = this.settleCurrent;
    this.settleCurrent = null;
    this.clearAll();
    try {
      this.source.synth.cancel();
    } catch {
      // A synthesiser that is already gone is not an error worth surfacing.
    }
    settle?.();
  }

  /** Test seam: cancel timers without touching the synthesiser. */
  dispose(): void {
    this.stop();
  }

  private clearAll(): void {
    for (const handle of this.timers) this.clearTimer(handle);
    this.timers.clear();
  }
}

/** Rates offered by the UI. Kept in one place so they cannot drift apart. */
export const SPEEDS = [0.5, 0.75, 1, 1.25] as const;

/**
 * How long to wait for `speechSynthesis.getVoices()` to fill in before treating
 * the browser as having no voices installed (spec 5.4, Phase 12).
 */
export const VOICE_WAIT_MS = 800;

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(1.5, Math.max(0.5, rate));
}
