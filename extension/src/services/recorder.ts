/**
 * Microphone recording (spec 5.5).
 *
 * Records a take in memory, exposes a live level for the meter/waveform, and
 * stops itself after ~1.5 s of silence or 30 s hard. The blob is never written
 * to storage (spec 5.5: audio is out of scope for v1.0 saves).
 *
 * The browser surface is injected so the stop policy and permission mapping are
 * unit-tested without a microphone.
 */

export interface MediaStreamTrackLike {
  stop(): void;
}

export interface MediaStreamLike {
  getTracks(): readonly MediaStreamTrackLike[];
}

export interface MediaRecorderLike {
  state?: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface AnalyserLike {
  fftSize: number;
  getByteTimeDomainData(array: Uint8Array<ArrayBuffer>): void;
}

export interface AudioSourceLike {
  connect(node: AnalyserLike): void;
}

export interface AudioContextLike {
  createAnalyser(): AnalyserLike;
  createMediaStreamSource(stream: MediaStreamLike): AudioSourceLike;
  close(): Promise<void>;
}

export interface RecorderDependencies {
  getUserMedia(constraints: { audio: true }): Promise<MediaStreamLike>;
  createRecorder(stream: MediaStreamLike): MediaRecorderLike | null;
  createAudioContext(): AudioContextLike | null;
  now(): number;
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export type RecordFailure = "denied" | "unavailable" | "unsupported" | "failed";

export interface Take {
  readonly blob: Blob;
  readonly durationMs: number;
  readonly mimeType: string;
}

export type StoppedBy = "user" | "silence" | "timeout";

export type RecordOutcome =
  | { readonly ok: true; readonly take: Take; readonly stoppedBy: StoppedBy }
  | { readonly ok: false; readonly reason: RecordFailure };

/** Thrown by `start()` so the UI can show the right permission message. */
export class RecorderError extends Error {
  readonly reason: RecordFailure;

  constructor(reason: RecordFailure) {
    super(reason);
    this.name = "RecorderError";
    this.reason = reason;
  }
}

export interface RecorderOptions {
  /** Silence after speech before auto-stopping (spec 5.5: ~1.5 s). */
  readonly silenceMs?: number;
  /** Hard cap (spec 5.5: 30 s). */
  readonly maxMs?: number;
  /** How often the level is sampled. */
  readonly levelIntervalMs?: number;
  /** RMS below this counts as silence. */
  readonly silenceThreshold?: number;
  /** Number of level samples kept for the waveform. */
  readonly peaks?: number;
  readonly onLevel?: (level: number, peaks: readonly number[]) => void;
  readonly deps?: Partial<RecorderDependencies>;
}

const DEFAULTS = {
  silenceMs: 1_500,
  maxMs: 30_000,
  levelIntervalMs: 80,
  silenceThreshold: 0.02,
  peaks: 64,
} as const;

function failureFor(error: unknown): RecordFailure {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { name?: unknown }).name;
    if (name === "NotAllowedError" || name === "SecurityError") return "denied";
    if (
      name === "NotFoundError" ||
      name === "NotReadableError" ||
      name === "OverconstrainedError"
    ) {
      return "unavailable";
    }
  }
  return "failed";
}

/** RMS of a time-domain byte buffer, normalised to 0..1. */
export function levelFromBytes(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let sum = 0;
  for (const byte of bytes) {
    const deviation = (byte - 128) / 128;
    sum += deviation * deviation;
  }
  return Math.min(1, Math.sqrt(sum / bytes.length));
}

export class Recorder {
  private readonly options: RecorderOptions;
  private readonly deps: RecorderDependencies;
  private readonly silenceMs: number;
  private readonly maxMs: number;
  private readonly levelIntervalMs: number;
  private readonly silenceThreshold: number;
  private readonly peakCount: number;

  private stream: MediaStreamLike | null = null;
  private recorder: MediaRecorderLike | null = null;
  private context: AudioContextLike | null = null;
  private analyser: AnalyserLike | null = null;
  private buffer: Uint8Array<ArrayBuffer> | null = null;
  private timer: unknown = null;

  private chunks: Blob[] = [];
  private peaks: number[] = [];
  private startedAt = 0;
  private lastLoudAt = 0;
  private heardSpeech = false;
  private finishing = false;
  private finishResult: ((outcome: RecordOutcome) => void) | null = null;
  private readonly ended: Promise<RecordOutcome>;
  private failed: RecordFailure | null = null;

  constructor(options: RecorderOptions = {}) {
    this.options = options;
    const browser = browserRecorderDependencies();
    this.deps = {
      getUserMedia:
        options.deps?.getUserMedia ??
        (browser ? (constraints) => browser.getUserMedia(constraints) : () => Promise.reject(new RecorderError("unsupported"))),
      createRecorder:
        options.deps?.createRecorder ??
        (browser ? (stream) => browser.createRecorder(stream) : () => null),
      createAudioContext:
        options.deps?.createAudioContext ??
        (browser ? () => browser.createAudioContext() : () => null),
      now: options.deps?.now ?? (() => Date.now()),
      setInterval: options.deps?.setInterval ?? ((handler, ms) => setInterval(handler, ms)),
      clearInterval: options.deps?.clearInterval ?? ((handle) => clearInterval(handle as number)),
    };

    this.silenceMs = options.silenceMs ?? DEFAULTS.silenceMs;
    this.maxMs = options.maxMs ?? DEFAULTS.maxMs;
    this.levelIntervalMs = options.levelIntervalMs ?? DEFAULTS.levelIntervalMs;
    this.silenceThreshold = options.silenceThreshold ?? DEFAULTS.silenceThreshold;
    this.peakCount = options.peaks ?? DEFAULTS.peaks;

    this.ended = new Promise<RecordOutcome>((resolve) => {
      this.finishResult = resolve;
    });
  }

  get isRecording(): boolean {
    return this.recorder !== null && !this.finishing;
  }

  /** The promise that settles when the take ends for any reason. */
  get result(): Promise<RecordOutcome> {
    return this.ended;
  }

  /** Ask for the microphone and begin recording. Rejects with `RecorderError`. */
  async start(): Promise<void> {
    if (this.recorder) return;

    let stream: MediaStreamLike;
    try {
      stream = await this.deps.getUserMedia({ audio: true });
    } catch (error) {
      throw new RecorderError(failureFor(error));
    }
    this.stream = stream;

    const recorder = this.deps.createRecorder(stream);
    if (!recorder) {
      await this.release();
      throw new RecorderError("unsupported");
    }
    this.recorder = recorder;
    this.chunks = [];
    this.peaks = [];
    this.startedAt = this.deps.now();
    this.lastLoudAt = this.startedAt;
    this.heardSpeech = false;
    this.finishing = false;
    this.failed = null;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    recorder.onerror = () => {
      this.failed = "failed";
      this.finish("user");
    };
    recorder.onstop = () => {
      this.finalise();
    };

    // Level metering is best-effort: a browser without Web Audio still records,
    // it just cannot draw a meter.
    const context = this.deps.createAudioContext();
    if (context) {
      try {
        this.context = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        context.createMediaStreamSource(stream).connect(analyser);
        this.analyser = analyser;
        this.buffer = new Uint8Array(analyser.fftSize);
      } catch {
        this.context = null;
        this.analyser = null;
        this.buffer = null;
      }
    }

    try {
      recorder.start();
    } catch {
      await this.release();
      throw new RecorderError("failed");
    }

    this.timer = this.deps.setInterval(() => this.sample(), this.levelIntervalMs);
  }

  /**
   * Stop the take. Idempotent: the first reason wins, later calls are ignored.
   * The returned promise settles when the data has been collected.
   */
  async stop(stoppedBy: StoppedBy = "user"): Promise<RecordOutcome> {
    if (!this.recorder) return { ok: false, reason: "failed" };
    this.finish(stoppedBy);
    return this.ended;
  }

  /** Abort and discard without waiting for the `ended` promise. */
  abort(): void {
    this.failed = "failed";
    this.finish("user");
  }

  private finish(stoppedBy: StoppedBy): void {
    if (this.finishing) return;
    this.finishing = true;
    this.stoppedBy = stoppedBy;

    if (this.timer !== null) {
      this.deps.clearInterval(this.timer);
      this.timer = null;
    }

    const recorder = this.recorder;
    if (!recorder) {
      this.finalise();
      return;
    }

    try {
      // Flush the last partial chunk before `onstop` fires.
      if (recorder.state !== "inactive") recorder.stop();
      else this.finalise();
    } catch {
      this.failed = "failed";
      this.finalise();
    }
  }

  private stoppedBy: StoppedBy = "user";

  private sample(): void {
    const now = this.deps.now();
    const elapsed = now - this.startedAt;

    if (elapsed >= this.maxMs) {
      this.finish("timeout");
      return;
    }

    if (!this.analyser || !this.buffer) return;
    this.analyser.getByteTimeDomainData(this.buffer);
    const level = levelFromBytes(this.buffer);

    this.peaks.push(level);
    if (this.peaks.length > this.peakCount) this.peaks.shift();
    this.options.onLevel?.(level, [...this.peaks]);

    if (level >= this.silenceThreshold) {
      this.heardSpeech = true;
      this.lastLoudAt = now;
    } else if (this.heardSpeech && now - this.lastLoudAt >= this.silenceMs) {
      this.finish("silence");
    }
  }

  private finalise(): void {
    if (!this.finishResult) return;
    const settle = this.finishResult;
    this.finishResult = null;

    const durationMs = Math.max(0, this.deps.now() - this.startedAt);
    const mimeType = this.chunks[0]?.type ?? "audio/webm";
    void this.release();

    if (this.failed !== null) {
      settle({ ok: false, reason: this.failed });
      return;
    }

    const blob = new Blob(this.chunks, { type: mimeType });
    if (blob.size === 0) {
      settle({ ok: false, reason: "failed" });
      return;
    }

    settle({
      ok: true,
      take: { blob, durationMs, mimeType },
      stoppedBy: this.stoppedBy,
    });
  }

  private async release(): Promise<void> {
    if (this.timer !== null) {
      this.deps.clearInterval(this.timer);
      this.timer = null;
    }
    for (const track of this.stream?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        // A track that is already ended is harmless.
      }
    }
    this.stream = null;
    this.recorder = null;
    this.analyser = null;
    this.buffer = null;

    const context = this.context;
    this.context = null;
    if (context) {
      try {
        await context.close();
      } catch {
        // Closing an already-closed context is harmless.
      }
    }
  }
}

/** Build the real browser dependencies, or null when recording is unsupported. */
export function browserRecorderDependencies(): RecorderDependencies | null {
  if (typeof window === "undefined") return null;
  if (typeof window.MediaRecorder === "undefined") return null;
  if (typeof navigator === "undefined" || typeof navigator.mediaDevices === "undefined") {
    return null;
  }

  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  return {
    getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    createRecorder: (stream) => {
      const streamLike = stream as unknown as MediaStream;
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
      ].find((type) => MediaRecorder.isTypeSupported(type));

      const recorder = new MediaRecorder(
        streamLike,
        mimeType ? { mimeType } : undefined,
      );
      // The DOM event types are wider than the narrow slice above.
      return {
        get state() {
          return recorder.state;
        },
        get ondataavailable() {
          return null;
        },
        set ondataavailable(handler: ((event: { data: Blob }) => void) | null) {
          recorder.ondataavailable = handler
            ? (event: BlobEvent) => handler({ data: event.data })
            : null;
        },
        get onstop() {
          return null;
        },
        set onstop(handler: (() => void) | null) {
          recorder.onstop = handler ? () => handler() : null;
        },
        get onerror() {
          return null;
        },
        set onerror(handler: ((event: unknown) => void) | null) {
          recorder.onerror = handler ? (event: Event) => handler(event) : null;
        },
        start: (timeslice) => recorder.start(timeslice),
        stop: () => recorder.stop(),
      };
    },
    createAudioContext: Context
      ? (): AudioContextLike => {
          const context = new Context();
          return {
            createAnalyser: () => context.createAnalyser(),
            createMediaStreamSource: (stream) => {
              const source = context.createMediaStreamSource(
                stream as unknown as MediaStream,
              );
              return {
                connect: (node) => source.connect(node as unknown as AudioNode),
              };
            },
            close: () => context.close(),
          };
        }
      : () => null,
    now: () => Date.now(),
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (handle) => clearInterval(handle as number),
  };
}
