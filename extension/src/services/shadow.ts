/**
 * The shadowing loop state machine (spec 5.7).
 *
 * `idle → playing → countdown → recording → review → … → done`, cancellable at
 * every stage. The loop owns sequencing only: playing the reference, recording
 * and waiting are injected, which keeps it deterministic in tests and lets the
 * panel wire the real speaker and recorder.
 *
 * The abort signal passed to every hook is the mechanism that guarantees no
 * overlapping audio and no orphaned microphone: the panel stops playback and
 * the recorder as soon as the signal fires.
 */

export type ShadowState =
  | "idle"
  | "playing"
  | "countdown"
  | "recording"
  | "review"
  | "done";

export interface ShadowHooks {
  /** Speak the reference for this round. Must resolve when playback ends. */
  playReference(round: number, signal: AbortSignal): Promise<void>;
  /** Record the learner's take. Must resolve when the take has been stored. */
  record(round: number, signal: AbortSignal): Promise<void>;
  /**
   * Wait between stages. Injected so tests need no real timers. Must resolve
   * early (not reject) when the signal aborts.
   */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  /** Called on every transition, including each countdown number. */
  onState(state: ShadowState, round: number, countdown?: number): void;
}

export interface ShadowOptions {
  /** 1, 3 or 5 (spec 4.3). */
  readonly rounds?: number;
  /** Pause on the review screen, and between rounds. */
  readonly gapMs?: number;
  /** Countdown numbers; spec says 3-2-1. */
  readonly countdownFrom?: number;
  /** How long each countdown number is shown. */
  readonly countdownMs?: number;
}

const DEFAULT_GAP_MS = 1_200;
const DEFAULT_COUNTDOWN_MS = 800;

/** An abortable sleep, used when callers do not inject a `wait`. */
export function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class ShadowLoop {
  private readonly hooks: ShadowHooks;
  private readonly rounds: number;
  private readonly gapMs: number;
  private readonly countdownFrom: number;
  private readonly countdownMs: number;

  private controller: AbortController | null = null;
  private currentState: ShadowState = "idle";
  private currentRound = 0;

  constructor(hooks: ShadowHooks, options: ShadowOptions = {}) {
    this.hooks = hooks;
    this.rounds = Math.max(1, Math.round(options.rounds ?? 3));
    this.gapMs = Math.max(0, options.gapMs ?? DEFAULT_GAP_MS);
    this.countdownFrom = Math.max(1, Math.round(options.countdownFrom ?? 3));
    this.countdownMs = Math.max(0, options.countdownMs ?? DEFAULT_COUNTDOWN_MS);
  }

  get state(): ShadowState {
    return this.currentState;
  }

  get round(): number {
    return this.currentRound;
  }

  get running(): boolean {
    return this.controller !== null;
  }

  /** Run the loop. Resolves `true` when it finished, `false` when cancelled. */
  async start(): Promise<boolean> {
    if (this.controller) return false;
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;

    try {
      for (let round = 1; round <= this.rounds; round += 1) {
        if (signal.aborted) return false;
        this.currentRound = round;

        this.setState("playing", round);
        await this.hooks.playReference(round, signal);

        if (signal.aborted) return false;
        for (let number = this.countdownFrom; number >= 1; number -= 1) {
          this.setState("countdown", round, number);
          await this.hooks.wait(this.countdownMs, signal);
          if (signal.aborted) return false;
        }

        this.setState("recording", round);
        await this.hooks.record(round, signal);

        if (signal.aborted) return false;
        this.setState("review", round);
        await this.hooks.wait(this.gapMs, signal);
      }

      if (signal.aborted) return false;
      this.setState("done", this.rounds);
      return true;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }

  /** Cancel at any stage. Safe to call repeatedly. */
  cancel(): void {
    if (!this.controller) return;
    this.controller.abort();
    this.controller = null;
    this.setState("idle", this.currentRound);
  }

  private setState(state: ShadowState, round: number, countdown?: number): void {
    this.currentState = state;
    this.hooks.onState(state, round, countdown);
  }
}
