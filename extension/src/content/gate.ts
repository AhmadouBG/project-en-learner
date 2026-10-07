/**
 * Should we react to this selection? (spec 5.1: "Debounce, and avoid reopening
 * UI that was just dismissed.")
 *
 * This is the layer between "the DOM told us something changed" and "the
 * micro-button appears". Without it the UI flickers and resurrects itself:
 *
 *  - `mouseup` fires repeatedly while a user finishes a drag;
 *  - clicking the micro-button itself looks like a new selection;
 *  - pressing Esc to dismiss and then clicking again would immediately reopen
 *    the pop-up the user just closed.
 *
 * Design: every decision takes an explicit `now`, so the whole policy is a pure
 * function of state and testable without fake timers or real delays. Nothing
 * here touches the DOM, and nothing here logs the text (spec 9).
 */

/** Spec 4.1: the button appears ~150 ms after the selection ends. */
export const APPEAR_DELAY_MS = 150;

/**
 * How long after a dismissal we ignore new selections entirely.
 *
 * Not specified. Chosen so that the click which follows pressing Esc does not
 * reopen what the user just closed, while staying short enough that the button
 * never feels broken if a real new selection happens quickly.
 */
export const DISMISS_SUPPRESSION_MS = 600;

/**
 * Tolerance for jitter in the selection rectangle, in CSS px.
 *
 * Compared as a DISTANCE, not by rounding to a grid: rounding puts a boundary
 * where a 2 px scroll can flip a selection from "same" to "different", which is
 * exactly the flicker we are trying to remove.
 */
const POSITION_TOLERANCE_PX = 6;

export interface SelectionCandidate {
  /** Already normalised by `normalizeText`; must be non-empty. */
  readonly text: string;
  readonly left: number;
  readonly top: number;
}

export type GateReason =
  | "ok"
  | "disabled"
  | "empty"
  | "not-speakable"
  | "suppressed"
  | "duplicate"
  | "dismissed";

export interface GateDecision {
  readonly show: boolean;
  readonly reason: GateReason;
}

export interface SelectionGateOptions {
  /** Mirrors `settings.showButtonOnSelection`. */
  readonly enabled?: boolean;
  readonly suppressMs?: number;
}

/**
 * Are two candidates the same user action?
 *
 * Same text, and the anchor sits within `POSITION_TOLERANCE_PX` of where it was
 * last time. Anything further away is a genuinely different selection, even if
 * the words match.
 */
function isSameSelection(
  a: SelectionCandidate | null,
  b: SelectionCandidate,
): boolean {
  if (!a) return false;
  if (a.text !== b.text) return false;
  return (
    Math.abs(a.left - b.left) <= POSITION_TOLERANCE_PX &&
    Math.abs(a.top - b.top) <= POSITION_TOLERANCE_PX
  );
}

export class SelectionGate {
  private enabled: boolean;
  private readonly suppressMs: number;

  /** The most recent selection we acted on, so repeats are ignored. */
  private lastShown: SelectionCandidate | null = null;
  /** The selection the user dismissed; never reopen it unchanged. */
  private dismissed: SelectionCandidate | null = null;
  private suppressedUntil = 0;

  constructor(options: SelectionGateOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.suppressMs = options.suppressMs ?? DISMISS_SUPPRESSION_MS;
  }

  /** Toggle at runtime, e.g. when the user changes the setting. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /**
   * Decide whether to show the micro-button for this selection.
   *
   * Order matters: cheap checks first, and `dismissed` before `duplicate` so the
   * reason reported to the UI is the more informative one.
   */
  evaluate(candidate: SelectionCandidate, now: number): GateDecision {
    if (!this.enabled) return reject("disabled");

    const text = candidate.text.trim();
    if (text === "") return reject("empty");
    // No letters or digits: selecting a divider or an emoji is not speech.
    if (!/\p{L}|\p{N}/u.test(text)) return reject("not-speakable");

    if (now < this.suppressedUntil) return reject("suppressed");

    const current: SelectionCandidate = { ...candidate, text };

    // Never resurrect the selection the user just dismissed, even once the
    // suppression window has passed. This blocks the "Esc, then click" reflex;
    // a deliberate later re-selection of the same words in the same place is
    // still allowed, because a different selection clears the marker.
    if (isSameSelection(this.dismissed, current)) return reject("dismissed");
    this.dismissed = null;

    if (isSameSelection(this.lastShown, current)) return reject("duplicate");

    this.lastShown = current;
    return { show: true, reason: "ok" };
  }

  /**
   * Record that the user dismissed the current UI. Suppresses new selections for
   * `suppressMs` and permanently blocks the selection that was on screen.
   */
  dismiss(candidate: SelectionCandidate | null, now: number): void {
    this.suppressedUntil = now + this.suppressMs;
    this.dismissed = candidate;
  }

  /**
   * Forget all state. Called when the page navigates, and when the panel takes
   * over, so a fresh session starts clean.
   */
  reset(): void {
    this.lastShown = null;
    this.dismissed = null;
    this.suppressedUntil = 0;
  }
}

function reject(reason: GateReason): GateDecision {
  return { show: false, reason };
}

// ---------------------------------------------------------------------------
// Debouncing
// ---------------------------------------------------------------------------

/**
 * A pending timer. The handle is opaque because it differs between Node
 * (`Timeout` objects) and browsers (numbers), and tests supply their own.
 */
export interface Timer {
  readonly handle: unknown;
}

export interface DebouncerOptions {
  readonly delayMs?: number;
  readonly setTimer?: (fn: () => void, ms: number) => Timer;
  readonly clearTimer?: (timer: Timer) => void;
}

/**
 * Trailing-edge debounce: run `fn` once, `delayMs` after the last call.
 *
 * Spec 5.1 asks us to debounce; spec 4.1 asks for a ~150 ms delay before the
 * button appears. Both fall out of this: rapid `mouseup` events collapse into
 * one delayed call, and cancelling on a new call stops a stale selection from
 * ever being shown.
 *
 * The timer functions are injectable so tests can drive them synchronously
 * instead of sleeping.
 */
export class Debouncer {
  private timer: Timer | null = null;
  private readonly delayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  private readonly fn: () => void;

  constructor(fn: () => void, options: DebouncerOptions = {}) {
    this.fn = fn;
    this.delayMs = options.delayMs ?? APPEAR_DELAY_MS;
    this.setTimer = options.setTimer ?? ((f, ms) => ({ handle: setTimeout(f, ms) }));
    this.clearTimer =
      options.clearTimer ??
      ((t) => clearTimeout(t.handle as ReturnType<typeof setTimeout>));
  }

  /** Schedule, replacing any pending call. */
  schedule(): void {
    this.cancel();
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.fn();
    }, this.delayMs);
  }

  cancel(): void {
    if (!this.timer) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }

  get isPending(): boolean {
    return this.timer !== null;
  }
}