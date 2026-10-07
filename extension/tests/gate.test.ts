import { describe, expect, it, vi } from "vitest";
import {
  APPEAR_DELAY_MS,
  Debouncer,
  DISMISS_SUPPRESSION_MS,
  SelectionGate,
  type SelectionCandidate,
  type Timer,
} from "../src/content/gate";

const at = (text: string, left = 100, top = 200): SelectionCandidate => ({
  text,
  left,
  top,
});

describe("SelectionGate: basics", () => {
  it("shows the button for a fresh, speakable selection", () => {
    const gate = new SelectionGate();
    expect(gate.evaluate(at("schedule"), 0)).toEqual({ show: true, reason: "ok" });
  });

  it("refuses when the setting is off", () => {
    const gate = new SelectionGate({ enabled: false });
    expect(gate.evaluate(at("schedule"), 0).reason).toBe("disabled");
  });

  it("can be toggled at runtime when the user changes the setting", () => {
    const gate = new SelectionGate();
    expect(gate.evaluate(at("schedule"), 0).show).toBe(true);

    gate.setEnabled(false);
    expect(gate.evaluate(at("record"), 1000).reason).toBe("disabled");

    gate.setEnabled(true);
    expect(gate.evaluate(at("record"), 2000).show).toBe(true);
  });

  it("refuses empty and whitespace-only selections", () => {
    const gate = new SelectionGate();
    expect(gate.evaluate(at(""), 0).reason).toBe("empty");
    expect(gate.evaluate(at("    "), 0).reason).toBe("empty");
  });

  it("refuses a selection with nothing to speak", () => {
    const gate = new SelectionGate();
    expect(gate.evaluate(at("|||"), 0).reason).toBe("not-speakable");
    expect(gate.evaluate(at("*** ---"), 0).reason).toBe("not-speakable");
  });
});

describe("SelectionGate: dedupe", () => {
  it("ignores a repeat of the selection it just acted on", () => {
    const gate = new SelectionGate();
    expect(gate.evaluate(at("schedule"), 0).show).toBe(true);
    // mouseup fires repeatedly while the user finishes a drag.
    expect(gate.evaluate(at("schedule"), 10).reason).toBe("duplicate");
    expect(gate.evaluate(at("schedule"), 50).reason).toBe("duplicate");
  });

  it("tolerates sub-pixel jitter in the rectangle", () => {
    const gate = new SelectionGate();
    expect(gate.evaluate(at("schedule", 100, 200), 0).show).toBe(true);
    // Scrolling by a few pixels must not count as a new selection. Rounding the
    // position to a grid would fail here, because a boundary can fall between
    // two almost-identical positions.
    expect(gate.evaluate(at("schedule", 101, 202), 10).reason).toBe("duplicate");
    expect(gate.evaluate(at("schedule", 106, 194), 20).reason).toBe("duplicate");
  });

  it("still treats a larger move as a different selection", () => {
    const gate = new SelectionGate();
    expect(gate.evaluate(at("schedule", 100, 200), 0).show).toBe(true);
    expect(gate.evaluate(at("schedule", 100, 200 + 40), 10).show).toBe(true);
  });

  it("treats a genuine move to a different place as a new selection", () => {
    const gate = new SelectionGate();
    expect(gate.evaluate(at("schedule", 100, 200), 0).show).toBe(true);
    expect(gate.evaluate(at("schedule", 900, 700), 10).show).toBe(true);
  });

  it("treats different text in the same spot as a new selection", () => {
    const gate = new SelectionGate();
    expect(gate.evaluate(at("schedule", 100, 200), 0).show).toBe(true);
    expect(gate.evaluate(at("record", 100, 200), 10).show).toBe(true);
  });

  it("does not confuse texts that merely look similar", () => {
    const gate = new SelectionGate();
    expect(gate.evaluate(at("aa@1,2"), 0).show).toBe(true);
    expect(gate.evaluate(at("a@1,2"), 10).show).toBe(true);
    expect(gate.evaluate(at("a@a1,2"), 20).show).toBe(true);
  });

  it("keys on the trimmed text, so stray whitespace is not a new selection", () => {
    const gate = new SelectionGate();
    expect(gate.evaluate(at("schedule"), 0).show).toBe(true);
    expect(gate.evaluate(at("  schedule  "), 10).reason).toBe("duplicate");
  });
});

describe("SelectionGate: dismissal", () => {
  it("suppresses new selections for the suppression window", () => {
    const gate = new SelectionGate();
    gate.dismiss(at("schedule"), 0);

    expect(gate.evaluate(at("something else"), 100).reason).toBe("suppressed");
    expect(gate.evaluate(at("something else"), DISMISS_SUPPRESSION_MS - 1).reason).toBe(
      "suppressed",
    );
    // Exactly at the boundary the window is over.
    expect(gate.evaluate(at("something else"), DISMISS_SUPPRESSION_MS).show).toBe(true);
  });

  it("never reopens the exact selection the user dismissed", () => {
    const gate = new SelectionGate();
    const dismissed = at("schedule", 100, 200);
    gate.dismiss(dismissed, 0);

    // Well past the suppression window: still refused, because it is the same
    // selection. This is the "Esc then click" reflex from spec 5.1.
    expect(gate.evaluate(dismissed, 60_000).reason).toBe("dismissed");
  });

  it("allows a genuinely different selection after a dismissal", () => {
    const gate = new SelectionGate();
    gate.dismiss(at("schedule", 100, 200), 0);
    expect(gate.evaluate(at("record", 500, 500), 60_000).show).toBe(true);
  });

  it("clears the dismissed marker once a different selection arrives", () => {
    const gate = new SelectionGate();
    const dismissed = at("schedule");
    gate.dismiss(dismissed, 0);

    // A different selection happens...
    expect(gate.evaluate(at("record"), 5000).show).toBe(true);
    // ...after which the old one is no longer specially blocked, only deduped
    // like any other repeat.
    expect(gate.evaluate(dismissed, 5000).show).toBe(true);
  });

  it("tolerates being dismissed with no selection on screen", () => {
    const gate = new SelectionGate();
    expect(() => gate.dismiss(null, 0)).not.toThrow();
    expect(gate.evaluate(at("schedule"), 10).reason).toBe("suppressed");
  });
});

describe("SelectionGate: reset", () => {
  it("forgets everything, so a fresh session starts clean", () => {
    const gate = new SelectionGate();
    expect(gate.evaluate(at("schedule"), 0).show).toBe(true);

    gate.reset();

    // Not "duplicate" any more: the same selection is showable again.
    expect(gate.evaluate(at("schedule"), 10).show).toBe(true);
  });

  it("clears a pending suppression", () => {
    const gate = new SelectionGate();
    gate.dismiss(at("schedule"), 0);
    gate.reset();
    expect(gate.evaluate(at("record"), 10).show).toBe(true);
  });
});

describe("SelectionGate: constants", () => {
  it("matches the spec delay", () => {
    expect(APPEAR_DELAY_MS).toBe(150);
  });

  it("uses a suppression window long enough to cover the follow-up click", () => {
    expect(DISMISS_SUPPRESSION_MS).toBeGreaterThan(APPEAR_DELAY_MS);
  });
});

describe("Debouncer", () => {
  /** Synchronous fake scheduler, so tests never sleep. */
  function fakeTimers() {
    let nextId = 1;
    const pending = new Map<number, () => void>();
    return {
      setTimer: (fn: () => void): Timer => {
        const id = nextId++;
        pending.set(id, fn);
        return { handle: id };
      },
      clearTimer: (timer: Timer): void => {
        pending.delete(timer.handle as number);
      },
      runAll: () => {
        const entries = [...pending.entries()];
        pending.clear();
        for (const [, fn] of entries) fn();
      },
      get size() {
        return pending.size;
      },
    };
  }

  it("does not run immediately", () => {
    const timers = fakeTimers();
    const fn = vi.fn();
    const debouncer = new Debouncer(fn, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    debouncer.schedule();
    expect(fn).not.toHaveBeenCalled();
    expect(debouncer.isPending).toBe(true);
  });

  it("runs once when the timer fires", () => {
    const timers = fakeTimers();
    const fn = vi.fn();
    const debouncer = new Debouncer(fn, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    debouncer.schedule();
    timers.runAll();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(debouncer.isPending).toBe(false);
  });

  it("collapses a burst of events into a single call", () => {
    const timers = fakeTimers();
    const fn = vi.fn();
    const debouncer = new Debouncer(fn, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    // mouseup storm while the user finishes a drag.
    for (let i = 0; i < 20; i += 1) debouncer.schedule();
    expect(timers.size).toBe(1);

    timers.runAll();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not fire after being cancelled, so a stale selection never shows", () => {
    const timers = fakeTimers();
    const fn = vi.fn();
    const debouncer = new Debouncer(fn, {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    debouncer.schedule();
    debouncer.cancel();
    timers.runAll();

    expect(fn).not.toHaveBeenCalled();
    expect(debouncer.isPending).toBe(false);
  });

  it("cancelling twice is harmless", () => {
    const timers = fakeTimers();
    const debouncer = new Debouncer(vi.fn(), {
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    debouncer.schedule();
    expect(() => {
      debouncer.cancel();
      debouncer.cancel();
    }).not.toThrow();
  });

  it("defaults to the spec delay", () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const debouncer = new Debouncer(fn);

      debouncer.schedule();
      vi.advanceTimersByTime(APPEAR_DELAY_MS - 1);
      expect(fn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});