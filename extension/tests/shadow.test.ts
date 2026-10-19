/**
 * Shadowing loop (spec 5.7, Phase 9 check): three rounds complete, cancel works
 * in every state, and stages never overlap because each hook is awaited.
 */

import { describe, expect, it } from "vitest";
import { ShadowLoop, type ShadowState } from "../src/services/shadow";

function immediateHooks(overrides: Partial<Parameters<typeof makeHooks>[0]> = {}) {
  return makeHooks({ wait: async () => undefined, ...overrides });
}

function makeHooks(config: {
  playReference?: (round: number, signal: AbortSignal) => Promise<void>;
  record?: (round: number, signal: AbortSignal) => Promise<void>;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const states: string[] = [];
  const active: string[] = [];
  let overlapping = false;

  const track = async (name: string, body: () => Promise<void>): Promise<void> => {
    if (active.length > 0) overlapping = true;
    active.push(name);
    try {
      await body();
    } finally {
      active.pop();
    }
  };

  const hooks = {
    states,
    overlapping: () => overlapping,
    onState: (state: ShadowState, round: number, countdown?: number) => {
      states.push(`${state}:${round}${countdown === undefined ? "" : `:${countdown}`}`);
    },
    playReference: (round: number, signal: AbortSignal) =>
      track("play", () => (config.playReference ?? (async () => undefined))(round, signal)),
    record: (round: number, signal: AbortSignal) =>
      track("record", () => (config.record ?? (async () => undefined))(round, signal)),
    wait: (ms: number, signal: AbortSignal) =>
      (config.wait ?? (async () => undefined))(ms, signal),
  };
  return hooks;
}

describe("ShadowLoop", () => {
  it("runs the requested number of rounds in order", async () => {
    const hooks = immediateHooks();
    const loop = new ShadowLoop(hooks, { rounds: 3, gapMs: 0, countdownMs: 0 });

    await expect(loop.start()).resolves.toBe(true);

    expect(hooks.states).toEqual([
      "playing:1",
      "countdown:1:3",
      "countdown:1:2",
      "countdown:1:1",
      "recording:1",
      "review:1",
      "playing:2",
      "countdown:2:3",
      "countdown:2:2",
      "countdown:2:1",
      "recording:2",
      "review:2",
      "playing:3",
      "countdown:3:3",
      "countdown:3:2",
      "countdown:3:1",
      "recording:3",
      "review:3",
      "done:3",
    ]);
    expect(loop.state).toBe("done");
    expect(loop.round).toBe(3);
    expect(hooks.overlapping()).toBe(false);
  });

  it("supports 1 and 5 rounds", async () => {
    const one = immediateHooks();
    await new ShadowLoop(one, { rounds: 1, countdownMs: 0 }).start();
    expect(one.states.filter((state) => state.startsWith("recording"))).toEqual(["recording:1"]);

    const five = immediateHooks();
    await new ShadowLoop(five, { rounds: 5, countdownMs: 0 }).start();
    expect(five.states.filter((state) => state.startsWith("recording"))).toHaveLength(5);
  });

  it("cancels during playback without starting a recording", async () => {
    let loop: ShadowLoop | null = null;
    const hooks = immediateHooks({
      playReference: (_round, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          // Cancel once the playing state has been announced.
          queueMicrotask(() => loop?.cancel());
        }),
    });
    loop = new ShadowLoop(hooks, { rounds: 3, countdownMs: 0 });

    await expect(loop.start()).resolves.toBe(false);
    expect(hooks.states).toContain("playing:1");
    expect(hooks.states.some((state) => state.startsWith("recording"))).toBe(false);
    expect(loop.state).toBe("idle");
  });

  it("cancels during the countdown", async () => {
    let loop: ShadowLoop | null = null;
    const hooks = immediateHooks({
      wait: (_ms, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          queueMicrotask(() => loop?.cancel());
        }),
    });
    loop = new ShadowLoop(hooks, { rounds: 3, countdownMs: 1 });

    await expect(loop.start()).resolves.toBe(false);
    expect(hooks.states).toContain("countdown:1:3");
    expect(hooks.states.some((state) => state.startsWith("recording"))).toBe(false);
  });

  it("cancels during recording", async () => {
    let loop: ShadowLoop | null = null;
    const hooks = immediateHooks({
      record: (_round, signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          queueMicrotask(() => loop?.cancel());
        }),
    });
    loop = new ShadowLoop(hooks, { rounds: 3, countdownMs: 0 });

    await expect(loop.start()).resolves.toBe(false);
    expect(hooks.states).toContain("recording:1");
    expect(hooks.states).not.toContain("review:1");
    expect(loop.state).toBe("idle");
  });

  it("cancels during review and does not start round 2", async () => {
    let loop: ShadowLoop | null = null;
    const hooks = immediateHooks({
      wait: (ms, signal) => {
        if (ms === 0) return Promise.resolve();
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          queueMicrotask(() => loop?.cancel());
        });
      },
    });
    loop = new ShadowLoop(hooks, { rounds: 3, countdownMs: 0, gapMs: 50 });

    await expect(loop.start()).resolves.toBe(false);
    expect(hooks.states).toContain("review:1");
    expect(hooks.states.some((state) => state.startsWith("playing:2"))).toBe(false);
  });

  it("will not start twice", async () => {
    const hooks = immediateHooks();
    const loop = new ShadowLoop(hooks, { rounds: 1, countdownMs: 0 });
    const first = loop.start();
    await expect(loop.start()).resolves.toBe(false);
    await expect(first).resolves.toBe(true);
  });

  it("cancel is safe when idle", () => {
    const loop = new ShadowLoop(immediateHooks(), { rounds: 1 });
    expect(() => loop.cancel()).not.toThrow();
    expect(loop.state).toBe("idle");
  });
});
