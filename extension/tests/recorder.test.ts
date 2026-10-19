/**
 * Recording policy (spec 5.5): permission mapping, auto-stop on silence, the
 * 30 s cap, and microphone release. A fake stream/recorder drives these, so the
 * tests say what happens without a real microphone.
 */

import { describe, expect, it, vi } from "vitest";
import {
  Recorder,
  RecorderError,
  levelFromBytes,
  type AnalyserLike,
  type MediaRecorderLike,
  type MediaStreamLike,
  type RecorderDependencies,
} from "../src/services/recorder";

interface Harness {
  readonly deps: RecorderDependencies;
  readonly tick: () => void;
  readonly trackStop: ReturnType<typeof vi.fn>;
  readonly contextClose: ReturnType<typeof vi.fn>;
  /** 128 is silence; 255 is full scale. */
  setLevel(byte: number): void;
  readonly clock: { now: number };
  readonly recorderStops: number;
}

function harness(options: { recorder?: MediaRecorderLike | null } = {}): Harness {
  let handler: (() => void) | null = null;
  const clock = { now: 0 };
  const trackStop = vi.fn();
  const contextClose = vi.fn(async () => undefined);
  let level = 128;
  let stops = 0;

  const recorder: MediaRecorderLike = options.recorder ?? {
    state: "inactive",
    ondataavailable: null,
    onstop: null,
    onerror: null,
    start() {
      this.state = "recording";
    },
    stop() {
      stops += 1;
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["take"], { type: "audio/webm" }) });
      this.onstop?.();
    },
  };

  const stream: MediaStreamLike = { getTracks: () => [{ stop: trackStop }] };
  const analyser: AnalyserLike = {
    fftSize: 256,
    getByteTimeDomainData(array) {
      array.fill(level);
    },
  };

  const deps: RecorderDependencies = {
    getUserMedia: async () => stream,
    createRecorder: () => (options.recorder === undefined ? recorder : options.recorder),
    createAudioContext: () => ({
      createAnalyser: () => analyser,
      createMediaStreamSource: () => ({ connect: () => undefined }),
      close: contextClose,
    }),
    now: () => clock.now,
    setInterval: (fn) => {
      handler = fn;
      return 1;
    },
    clearInterval: () => {
      handler = null;
    },
  };

  return {
    deps,
    tick: () => handler?.(),
    trackStop,
    contextClose,
    setLevel: (byte) => {
      level = byte;
    },
    clock,
    get recorderStops() {
      return stops;
    },
  };
}

describe("levelFromBytes", () => {
  it("reads silence as zero and full scale as one", () => {
    expect(levelFromBytes(new Uint8Array([128, 128, 128]))).toBe(0);
    expect(levelFromBytes(new Uint8Array([255, 255, 255]))).toBeCloseTo(0.992, 2);
    expect(levelFromBytes(new Uint8Array([]))).toBe(0);
  });
});

describe("Recorder", () => {
  it("maps a denied microphone to RecorderError('denied')", async () => {
    const deps = harness().deps;
    deps.getUserMedia = async () => {
      throw Object.assign(new Error("no"), { name: "NotAllowedError" });
    };
    const recorder = new Recorder({ deps });

    await expect(recorder.start()).rejects.toMatchObject({ reason: "denied" });
    await expect(recorder.start()).rejects.toBeInstanceOf(RecorderError);
  });

  it("maps a missing input device to 'unavailable'", async () => {
    const deps = harness().deps;
    deps.getUserMedia = async () => {
      throw Object.assign(new Error("no device"), { name: "NotFoundError" });
    };
    await expect(new Recorder({ deps }).start()).rejects.toMatchObject({
      reason: "unavailable",
    });
  });

  it("reports unsupported when MediaRecorder cannot be created", async () => {
    const deps = harness().deps;
    deps.createRecorder = () => null;
    await expect(new Recorder({ deps }).start()).rejects.toMatchObject({
      reason: "unsupported",
    });
  });

  it("records, stops on request, and releases the microphone", async () => {
    const h = harness();
    const levels: number[] = [];
    const recorder = new Recorder({
      deps: h.deps,
      onLevel: (level) => levels.push(level),
    });

    await recorder.start();
    expect(recorder.isRecording).toBe(true);
    h.setLevel(255);
    h.tick();
    expect(levels).toHaveLength(1);

    h.clock.now = 2_000;
    const outcome = await recorder.stop("user");

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.take.blob.size).toBeGreaterThan(0);
      expect(outcome.take.durationMs).toBe(2_000);
      expect(outcome.stoppedBy).toBe("user");
    }
    expect(h.trackStop).toHaveBeenCalled();
    expect(h.contextClose).toHaveBeenCalled();
    expect(recorder.isRecording).toBe(false);
  });

  it("auto-stops after ~1.5 s of silence once speech was heard", async () => {
    const h = harness();
    const recorder = new Recorder({ deps: h.deps });

    await recorder.start();
    h.setLevel(255);
    h.clock.now = 100;
    h.tick();

    h.setLevel(128);
    h.clock.now = 1_500;
    h.tick();
    h.clock.now = 1_700;
    h.tick();

    const outcome = await recorder.result;
    expect(outcome).toMatchObject({ ok: true, stoppedBy: "silence" });
  });

  it("does not auto-stop on silence before any speech", async () => {
    const h = harness();
    const recorder = new Recorder({ deps: h.deps });

    await recorder.start();
    h.clock.now = 10_000;
    h.tick();
    expect(recorder.isRecording).toBe(true);

    h.clock.now = 30_000;
    h.tick();
    await expect(recorder.result).resolves.toMatchObject({ ok: true, stoppedBy: "timeout" });
  });

  it("fails cleanly when the recorder produces no data", async () => {
    const empty: MediaRecorderLike = {
      state: "inactive",
      ondataavailable: null,
      onstop: null,
      onerror: null,
      start() {
        this.state = "recording";
      },
      stop() {
        this.state = "inactive";
        this.onstop?.();
      },
    };
    const h = harness({ recorder: empty });
    const recorder = new Recorder({ deps: h.deps });

    await recorder.start();
    await expect(recorder.stop()).resolves.toEqual({ ok: false, reason: "failed" });
  });
});
