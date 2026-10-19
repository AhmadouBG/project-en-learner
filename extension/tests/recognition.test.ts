/**
 * Web Speech recognition wrapper (spec 5.6).
 *
 * The engine itself is a browser black box, so the wrapper's contract is what
 * matters: accumulate final results, map permission/network errors, and always
 * settle exactly once.
 */

import { describe, expect, it, vi } from "vitest";
import {
  recognise,
  type RecognitionEventLike,
  type RecognitionLike,
  type RecognitionResultLike,
} from "../src/services/recognition";

function result(transcript: string, isFinal = true, confidence = 0.9): RecognitionResultLike {
  return { isFinal, length: 1, 0: { transcript, confidence } };
}

function event(results: RecognitionResultLike[], resultIndex = 0): RecognitionEventLike {
  return {
    resultIndex,
    results: { ...results, length: results.length },
  };
}

interface Fake {
  engine: RecognitionLike;
  factory: () => RecognitionLike;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

function fakeEngine(): Fake {
  const start = vi.fn();
  const stop = vi.fn();
  const abort = vi.fn();
  const engine: RecognitionLike = {
    lang: "",
    continuous: false,
    interimResults: true,
    maxAlternatives: 1,
    start,
    stop,
    abort,
    onresult: null,
    onerror: null,
    onend: null,
  };
  return { engine, factory: () => engine, start, stop, abort };
}

describe("recognise", () => {
  it("configures the engine for the requested accent", () => {
    const fake = fakeEngine();
    recognise(fake.factory, { lang: "en-GB" });
    expect(fake.engine.lang).toBe("en-GB");
    expect(fake.engine.continuous).toBe(true);
    expect(fake.engine.interimResults).toBe(false);
    expect(fake.engine.maxAlternatives).toBe(3);
    expect(fake.start).toHaveBeenCalledOnce();
  });

  it("accumulates final results and resolves with the transcript", async () => {
    const fake = fakeEngine();
    const session = recognise(fake.factory, { lang: "en-US" });

    fake.engine.onresult?.(event([result("Could you")]));
    fake.engine.onresult?.(event([result("Could you"), result("schedule it?", true, 0.7)], 1));
    // Interim results are ignored.
    fake.engine.onresult?.(
      event([result("Could you"), result("schedule it?"), result("half", false)], 2),
    );
    fake.engine.onend?.();

    await expect(session.result).resolves.toEqual({
      ok: true,
      transcript: "Could you schedule it?",
      confidence: 0.9,
    });
  });

  it("maps a denied microphone to a friendly reason", async () => {
    const fake = fakeEngine();
    const session = recognise(fake.factory, { lang: "en-US" });
    fake.engine.onerror?.({ error: "not-allowed" });
    await expect(session.result).resolves.toEqual({ ok: false, reason: "denied" });
  });

  it("maps no-speech and network failures", async () => {
    const first = fakeEngine();
    const firstSession = recognise(first.factory, { lang: "en-US" });
    first.engine.onerror?.({ error: "no-speech" });
    await expect(firstSession.result).resolves.toEqual({ ok: false, reason: "no-speech" });

    const second = fakeEngine();
    const secondSession = recognise(second.factory, { lang: "en-US" });
    second.engine.onerror?.({ error: "network" });
    await expect(secondSession.result).resolves.toEqual({ ok: false, reason: "network" });
  });

  it("treats an empty final result as no-speech", async () => {
    const fake = fakeEngine();
    const session = recognise(fake.factory, { lang: "en-US" });
    fake.engine.onend?.();
    await expect(session.result).resolves.toEqual({ ok: false, reason: "no-speech" });
  });

  it("stops once and ignores a second stop", () => {
    const fake = fakeEngine();
    const session = recognise(fake.factory, { lang: "en-US" });
    session.stop();
    session.stop();
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it("aborts without waiting for onend", async () => {
    const fake = fakeEngine();
    const session = recognise(fake.factory, { lang: "en-US" });
    session.abort();
    expect(fake.abort).toHaveBeenCalledOnce();
    await expect(session.result).resolves.toEqual({ ok: false, reason: "failed" });
  });

  it("reports unsupported when the browser has no engine", async () => {
    const session = recognise(() => null, { lang: "en-US" });
    await expect(session.result).resolves.toEqual({ ok: false, reason: "unsupported" });
  });

  it("reports failure when start throws", async () => {
    const fake = fakeEngine();
    fake.start.mockImplementation(() => {
      throw new Error("already started");
    });
    const session = recognise(fake.factory, { lang: "en-US" });
    await expect(session.result).resolves.toEqual({ ok: false, reason: "failed" });
  });
});
