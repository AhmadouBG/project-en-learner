/**
 * TTS voice selection, chunking and the speaker loop (spec 5.4).
 *
 * These run against a fake synthesiser so they are deterministic on Node. The
 * behaviours pinned here are the ones users notice: the right accent, no
 * overlapping audio, long text that does not stop halfway, and stress/word
 * highlighting that maps back to the original string.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MAX_CHUNK_CHARS,
  SPEEDS,
  Speaker,
  chooseVoice,
  clampRate,
  splitIntoChunks,
  voicesForAccent,
  type SpeechSource,
  type UtteranceLike,
  type VoiceLike,
} from "../src/services/tts";

const usVoice: VoiceLike = { name: "US Voice", lang: "en-US", localService: true };
const gbVoice: VoiceLike = { name: "UK Voice", lang: "en-GB", localService: true };
const auVoice: VoiceLike = { name: "AU Voice", lang: "en-AU", localService: true };

describe("chooseVoice", () => {
  it("prefers an exact accent match", () => {
    expect(chooseVoice([auVoice, gbVoice, usVoice], "en-US")).toBe(usVoice);
    expect(chooseVoice([auVoice, gbVoice, usVoice], "en-GB")).toBe(gbVoice);
  });

  it("honours the user's stored voice when it still exists", () => {
    expect(chooseVoice([usVoice, gbVoice], "en-US", "UK Voice")).toBe(gbVoice);
    expect(chooseVoice([usVoice], "en-US", "Deleted Voice")).toBe(usVoice);
  });

  it("prefers a local voice over a remote one, then the default", () => {
    const remote: VoiceLike = { name: "Remote", lang: "en-US", localService: false };
    const local: VoiceLike = { name: "Local", lang: "en-US", localService: true };
    expect(chooseVoice([remote, local], "en-US")).toBe(local);

    const first: VoiceLike = { name: "First", lang: "en-US" };
    const systemDefault: VoiceLike = { name: "Default", lang: "en-US", default: true };
    expect(chooseVoice([first, systemDefault], "en-US")).toBe(systemDefault);
  });

  it("returns null rather than mislabelling another English variety", () => {
    expect(chooseVoice([auVoice], "en-GB")).toBeNull();
    expect(chooseVoice([], "en-US")).toBeNull();
  });
});

describe("voicesForAccent", () => {
  it("lists only voices for that accent", () => {
    expect(voicesForAccent([auVoice, gbVoice, usVoice], "en-GB")).toEqual([gbVoice]);
  });
});

describe("splitIntoChunks", () => {
  it("keeps short text in one chunk", () => {
    expect(splitIntoChunks("Could you schedule the meeting?")).toEqual([
      { text: "Could you schedule the meeting?", offset: 0 },
    ]);
  });

  it("splits at word boundaries and preserves offsets", () => {
    const text = "alpha beta gamma delta";
    const chunks = splitIntoChunks(text, 12);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["alpha beta", "gamma delta"]);
    for (const chunk of chunks) {
      expect(text.slice(chunk.offset).startsWith(chunk.text)).toBe(true);
    }
  });

  it("hard-splits a token longer than the limit", () => {
    const chunks = splitIntoChunks("abcdefghij", 4);
    expect(chunks.map((chunk) => chunk.text)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("never exceeds the default maximum for normal prose", () => {
    const text = "one two three four ".repeat(200);
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  it("skips leading and trailing whitespace", () => {
    expect(splitIntoChunks("   hello   ", 20)).toEqual([{ text: "hello", offset: 3 }]);
    expect(splitIntoChunks("   ", 20)).toEqual([]);
  });
});

describe("clampRate", () => {
  it("keeps rates inside the supported range", () => {
    expect(clampRate(0.1)).toBe(0.5);
    expect(clampRate(9)).toBe(1.5);
    expect(clampRate(Number.NaN)).toBe(1);
    for (const speed of SPEEDS) expect(clampRate(speed)).toBe(speed);
  });
});

interface FakeSource {
  readonly source: SpeechSource;
  readonly spoken: UtteranceLike[];
  readonly cancel: ReturnType<typeof vi.fn>;
  /** Make every utterance finish on the next microtask. */
  autoEnd: boolean;
  /** Fire a boundary event at the given index before ending. */
  boundaryAt: number | null;
  /** Fire `onerror` with this value instead of ending. */
  failWith: string | null;
  setVoices(voices: readonly VoiceLike[]): void;
}

function fakeSource(voices: readonly VoiceLike[] = [usVoice, gbVoice]): FakeSource {
  const spoken: UtteranceLike[] = [];
  let current = [...voices];
  const cancel = vi.fn();

  const fake: FakeSource = {
    spoken,
    cancel,
    autoEnd: true,
    boundaryAt: null,
    failWith: null,
    setVoices(next) {
      current = [...next];
    },
    source: {
      synth: {
        getVoices: () => current,
        speak: (utterance) => {
          spoken.push(utterance);
          queueMicrotask(() => {
            if (fake.failWith !== null) {
              utterance.onerror?.({ error: fake.failWith });
              return;
            }
            if (fake.boundaryAt !== null) {
              utterance.onboundary?.({ charIndex: fake.boundaryAt });
            }
            if (fake.autoEnd) utterance.onend?.();
          });
        },
        cancel,
      },
      createUtterance: (text) => ({
        text,
        lang: "",
        rate: 1,
        voice: null,
        onboundary: null,
        onend: null,
        onerror: null,
      }),
    },
  };
  return fake;
}

describe("Speaker", () => {
  it("speaks every chunk in order and applies accent, rate and voice", async () => {
    const fake = fakeSource();
    const speaker = new Speaker({ source: fake.source });
    const text = `${"alpha beta ".repeat(30)}end`;

    await speaker.speak(text, { accent: "en-GB", rate: 0.75 });

    expect(fake.spoken.length).toBeGreaterThan(1);
    expect(fake.spoken.map((utterance) => utterance.text).join(" ")).toBe(
      text.replace(/\s+/g, " ").trim(),
    );
    for (const utterance of fake.spoken) {
      expect(utterance.lang).toBe("en-GB");
      expect(utterance.rate).toBe(0.75);
      expect(utterance.voice).toBe(gbVoice);
    }
  });

  it("maps chunk boundary events back to the original string", async () => {
    const fake = fakeSource();
    fake.boundaryAt = 2;
    const speaker = new Speaker({ source: fake.source });
    const seen: number[] = [];

    await speaker.speak("alpha beta gamma delta epsilon zeta eta theta", {
      accent: "en-US",
      onBoundary: (index) => seen.push(index),
    });

    expect(seen.length).toBeGreaterThan(0);
    // Every reported index belongs to a word start in the source text.
    for (const index of seen) expect("alpha beta gamma delta epsilon zeta eta theta"[index]).not.toBe(" ");
  });

  it("resolves and reports an error when a voice fails", async () => {
    const fake = fakeSource();
    fake.failWith = "failed";
    const speaker = new Speaker({ source: fake.source });
    const onError = vi.fn();

    await speaker.speak("hello", { accent: "en-US", onError });

    expect(onError).toHaveBeenCalledWith("failed");
    expect(speaker.isSpeaking).toBe(false);
  });

  it("does not report a cancellation as an error", async () => {
    const fake = fakeSource();
    fake.failWith = "canceled";
    const speaker = new Speaker({ source: fake.source });
    const onError = vi.fn();

    await speaker.speak("hello", { accent: "en-US", onError });

    expect(onError).not.toHaveBeenCalled();
  });

  it("resolves an in-flight speak when stopped, so awaiting callers never hang", async () => {
    const fake = fakeSource();
    fake.autoEnd = false;
    const speaker = new Speaker({ source: fake.source });

    const playback = speaker.speak("hello", { accent: "en-US" });
    expect(speaker.isSpeaking).toBe(true);
    speaker.stop();
    await expect(playback).resolves.toBeUndefined();

    expect(fake.cancel).toHaveBeenCalled();
    expect(speaker.isSpeaking).toBe(false);
  });

  it("does nothing for empty text but still calls onEnd", async () => {
    const fake = fakeSource();
    const speaker = new Speaker({ source: fake.source });
    const onEnd = vi.fn();

    await speaker.speak("   ", { accent: "en-US", onEnd });

    expect(fake.spoken).toHaveLength(0);
    expect(onEnd).toHaveBeenCalledOnce();
  });
});
