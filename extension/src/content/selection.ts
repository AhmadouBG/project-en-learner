/**
 * Selection capture (spec 5.1).
 *
 * Watches for a selection being made and reports it. This module READS the
 * selection; the micro-button module decides what to show.
 *
 * Rules enforced here:
 *  - never clear the user's selection (spec 5.1). The previous implementation in
 *    `frontend/Panel.js` called `selection.removeAllRanges()` 50 ms after a
 *    `mouseup`, which destroyed the user's selection before they could act on
 *    it. We never touch it.
 *  - never react to password fields or browser surfaces (see `guards.ts`);
 *  - never react to our own UI or to synthetic events;
 *  - debounce, and do not reopen UI the user just dismissed.
 *
 * Spec 9: never log the selected text.
 */

import { normalizeText, isSpeakableText } from "./normalize";
import {
  activeElementIsPassword,
  eventComesFromUs,
  isHiddenNode,
  isPasswordSelection,
  isUnreadableNode,
  restrictedReason,
} from "./guards";
import { SelectionGate, Debouncer, type SelectionCandidate } from "./gate";
import type { PracticeTarget } from "../shared/messages";

export interface ResolvedSelection {
  /** Normalised text; never logged. */
  readonly text: string;
  readonly rect: DOMRect;
  readonly anchorNode: Node | null;
  readonly focusNode: Node | null;
}

export interface WatcherOptions {
  /** Mirrors `settings.showButtonOnSelection`. */
  readonly enabled?: boolean;
  /** Called when a new, acceptable selection is made. */
  readonly onSelection: (selection: ResolvedSelection) => void;
  /** Called when the selection went away, or the user dismissed our UI. */
  readonly onDismiss: () => void;
  /** Injectable clock, so the gate policy stays testable. */
  readonly now?: () => number;
  /** Debounce delay; defaults to the spec's ~150 ms. */
  readonly appearDelayMs?: number;
  /** Injected in tests. */
  readonly setTimer?: (fn: () => void, ms: number) => { handle: unknown };
  readonly clearTimer?: (timer: { handle: unknown }) => void;
  /**
   * Returns the host of our own injected UI so we can ignore events coming from
   * inside it (spec 5.1). A getter, not a value, because the button mounts
   * lazily and there is no host until the first selection is accepted.
   */
  readonly ownHost?: () => HTMLElement | null;
}

export interface WatcherController {
  destroy(): void;
  /** Dismiss as if the user pressed Esc; used by the button. */
  dismiss(): void;
}

/** Build a target for the side panel from a selection. */
export function targetFromSelection(
  selection: ResolvedSelection,
  accent: PracticeTarget["accent"],
  speed: number,
): PracticeTarget {
  const text = selection.text;
  return {
    text,
    kind: text.includes(" ") ? "sentence" : "word",
    accent,
    speed,
  };
}

/**
 * Read the current selection.
 *
 * Shadow-DOM text: Chrome 124+ exposes `Selection.getComposedRanges()`, which
 * returns ranges that cross shadow boundaries. Older Chrome only reports ranges
 * inside the current tree, so we fall back to `getRangeAt(0)`.
 */
export function readSelection(): ResolvedSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const raw = selection.toString();
  if (raw.trim() === "") return null;

  const text = normalizeText(raw);
  if (!isSpeakableText(text)) return null;

  // Prefer composed ranges so text inside a web component is reachable. Bound to
  // `selection`, since this is a method on the Selection interface.
  let range: Range | StaticRange | null = null;
  // `getComposedRanges` is newer than some TypeScript DOM libs, so it is
  // declared here with an explicit `this`, which also satisfies ESLint's
  // unbound-method rule when we alias it off the instance.
  type ComposedRangeSelection = Selection & {
    getComposedRanges?: (this: Selection) => StaticRange[];
  };
  const composedHost = selection as ComposedRangeSelection;

  // Called as a method on the object, never aliased, so the receiver is kept.
  if (typeof composedHost.getComposedRanges === "function") {
    try {
      const ranges = composedHost.getComposedRanges();
      if (ranges.length > 0) range = ranges[0] ?? null;
    } catch {
      // Some engines throw on a collapsed selection; fall through.
    }
  }
  if (!range) {
    try {
      range = selection.getRangeAt(0);
    } catch {
      return null;
    }
  }

  const anchorNode = selection.anchorNode ?? range.startContainer ?? null;
  const focusNode = selection.focusNode ?? range.endContainer ?? null;

  const rect = rectOfRange(range, anchorNode);
  if (!rect) return null;

  return { text, rect, anchorNode, focusNode };
}

/**
 * A usable rectangle for the range, with fallbacks.
 *
 * A range that spans a block-level element can report a zero-height rect, and a
 * StaticRange may not implement the rect methods at all, so we degrade to the
 * first client rect and then to the anchor element.
 */
function rectOfRange(
  range: Range | StaticRange,
  anchorNode: Node | null,
): DOMRect | null {
  const withRects = range as Partial<Range>;

  if (typeof withRects.getBoundingClientRect === "function") {
    const rect = withRects.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) return rect;
  }

  if (typeof withRects.getClientRects === "function") {
    const rects = withRects.getClientRects();
    const first = rects?.[0];
    if (first && (first.width > 0 || first.height > 0)) return first;
  }

  // Last resort: the element containing the start of the selection.
  const element = anchorNode?.nodeType === 1 ? (anchorNode as Element) : anchorNode?.parentElement;
  if (element && typeof element.getBoundingClientRect === "function") {
    const rect = element.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) return rect;
  }

  return null;
}

/**
 * Should we act on this selection? Runs every guard, cheapest first.
 * Exported so the acceptance check can assert individual rules.
 */
export function isActionableSelection(selection: ResolvedSelection, pageUrl: string): boolean {
  if (restrictedReason(pageUrl) !== null) return false;
  if (isPasswordSelection(selection.anchorNode, selection.focusNode)) return false;
  if (activeElementIsPassword()) return false;
  if (isUnreadableNode(selection.anchorNode)) return false;
  if (isHiddenNode(selection.anchorNode)) return false;
  if (!isSpeakableText(selection.text)) return false;
  return true;
}

/**
 * Start watching. Attaches capture-phase listeners so we see the selection
 * before the page can swallow it, and cleans everything up on `destroy`.
 */
export function createSelectionWatcher(
  options: WatcherOptions,
): WatcherController {
  const now = options.now ?? (() => Date.now());
  const gate = new SelectionGate({ enabled: options.enabled ?? true });

  let destroyed = false;
  /** The selection currently on screen, so a dismissal can be attributed to it. */
  let current: ResolvedSelection | null = null;

  const clear = () => {
    if (!current) return;
    current = null;
    options.onDismiss();
  };

  const check = () => {
    if (destroyed) return;

    const selection = readSelection();
    if (!selection) {
      // The selection was cleared or collapsed: hide, but do not treat it as a
      // dismissal, or the gate would suppress the next real selection.
      current = null;
      options.onDismiss();
      return;
    }

    if (!isActionableSelection(selection, window.location.href)) {
      current = null;
      options.onDismiss();
      return;
    }

    const candidate: SelectionCandidate = {
      text: selection.text,
      left: selection.rect.left,
      top: selection.rect.top,
    };

    const decision = gate.evaluate(candidate, now());
    if (!decision.show) {
      // A duplicate or suppressed decision means our UI is already correct.
      return;
    }

    current = selection;
    options.onSelection(selection);
  };

  const debouncer = new Debouncer(check, {
    ...(options.appearDelayMs !== undefined ? { delayMs: options.appearDelayMs } : {}),
    ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
  });

  const onPointerUp = (event: Event) => {
    if (eventComesFromUs(event, options.ownHost?.() ?? null)) return;
    debouncer.schedule();
  };

  const onKeyUp = (event: Event) => {
    if (eventComesFromUs(event, options.ownHost?.() ?? null)) return;
    // Shift+Arrow and Ctrl+A both change the selection without a pointer.
    if (event instanceof KeyboardEvent && !event.shiftKey && event.key !== "a") return;
    debouncer.schedule();
  };

  const onSelectionChange = () => {
    // `selectionchange` also fires when our own UI gains focus, which would
    // immediately dismiss the button we just showed.
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) clear();
  };

  document.addEventListener("mouseup", onPointerUp, true);
  document.addEventListener("keyup", onKeyUp, true);
  document.addEventListener("selectionchange", onSelectionChange);

  return {
    destroy() {
      destroyed = true;
      debouncer.cancel();
      document.removeEventListener("mouseup", onPointerUp, true);
      document.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
    },

    dismiss() {
      debouncer.cancel();
      const dismissed = current;
      gate.dismiss(
        dismissed
          ? { text: dismissed.text, left: dismissed.rect.left, top: dismissed.rect.top }
          : null,
        now(),
      );
      clear();
    },
  };
}