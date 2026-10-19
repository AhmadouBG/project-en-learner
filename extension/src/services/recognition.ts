/**
 * Web Speech recognition wrapper (spec 5.6).
 *
 * Chrome exposes `webkitSpeechRecognition`; the standardised spelling exists in
 * newer builds. Neither is in the DOM typings we compile against, so this module
 * declares the narrow slice it uses and keeps all browser-specific names here.
 *
 * Recognition may send audio to Google's service, which is why the UI shows a
 * privacy note and the setting that disables the check (spec 5.6).
 */

export interface RecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence: number;
}

export interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternativeLike | undefined;
}

export interface RecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: RecognitionResultLike | undefined;
  };
}

export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

export type RecognitionFactory = () => RecognitionLike | null;

type RecognitionConstructor = new () => RecognitionLike;

/** Build a factory from the real browser API, or null when unsupported. */
export function browserRecognitionFactory(): RecognitionFactory | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  const Constructor = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (!Constructor) return null;
  return () => new Constructor();
}

export type RecognitionFailure =
  | "unsupported"
  | "denied"
  | "no-speech"
  | "unavailable"
  | "network"
  | "failed";

export type RecognitionOutcome =
  | {
      readonly ok: true;
      readonly transcript: string;
      /** Best confidence reported for the final result, 0 when absent. */
      readonly confidence: number;
    }
  | { readonly ok: false; readonly reason: RecognitionFailure };

export interface RecognitionSession {
  /** Ask the engine to finish and return the transcript collected so far. */
  stop(): void;
  /** Abort without producing a result. Safe to call repeatedly. */
  abort(): void;
  readonly result: Promise<RecognitionOutcome>;
}

function failureFor(code: string): RecognitionFailure {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "denied";
    case "no-speech":
      return "no-speech";
    case "audio-capture":
      return "unavailable";
    case "network":
      return "network";
    case "aborted":
      return "failed";
    default:
      return "failed";
  }
}

/**
 * Start a recognition session.
 *
 * Results can arrive in several events; final ones are accumulated. Only
 * alternatives marked final count, so a half-heard word is not reported as a
 * substitution.
 */
export function recognise(
  factory: RecognitionFactory,
  options: { readonly lang: string },
): RecognitionSession {
  let settled = false;
  let stopped = false;
  let confidence = 0;
  const finals: string[] = [];
  let resolveResult: (outcome: RecognitionOutcome) => void = () => undefined;
  const result = new Promise<RecognitionOutcome>((resolve) => {
    resolveResult = resolve;
  });

  const finish = (outcome: RecognitionOutcome): void => {
    if (settled) return;
    settled = true;
    resolveResult(outcome);
  };

  let recognition: RecognitionLike | null;
  try {
    recognition = factory();
  } catch {
    recognition = null;
  }

  if (!recognition) {
    finish({ ok: false, reason: "unsupported" });
    return {
      result,
      stop: () => undefined,
      abort: () => undefined,
    };
  }

  const engine = recognition;
  engine.lang = options.lang;
  engine.continuous = true;
  engine.interimResults = false;
  engine.maxAlternatives = 3;

  engine.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const item = event.results[index];
      if (!item?.isFinal) continue;
      const best = item[0];
      if (!best || best.transcript.trim() === "") continue;
      finals.push(best.transcript.trim());
      confidence = Math.max(confidence, best.confidence);
    }
  };

  engine.onerror = (event) => {
    finish({ ok: false, reason: failureFor(event.error) });
  };

  engine.onend = () => {
    const transcript = finals.join(" ").trim();
    if (transcript === "") {
      finish({ ok: false, reason: "no-speech" });
      return;
    }
    finish({ ok: true, transcript, confidence });
  };

  try {
    engine.start();
  } catch {
    // `InvalidStateError` means it was already started by another component;
    // there is nothing useful to do except report the feature as unavailable.
    finish({ ok: false, reason: "failed" });
  }

  return {
    result,
    stop: () => {
      if (settled || stopped) return;
      stopped = true;
      try {
        engine.stop();
      } catch {
        finish({ ok: false, reason: "failed" });
      }
    },
    abort: () => {
      if (settled) return;
      stopped = true;
      try {
        engine.abort();
      } catch {
        // Ignore: aborting an engine that already ended is harmless.
      }
      finish({ ok: false, reason: "failed" });
    },
  };
}
