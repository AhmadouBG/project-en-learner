/**
 * Shadow-DOM mount helper (spec 3: "All injected UI (micro-button, pop-up) lives
 * in a shadow DOM so page CSS cannot break it and ours cannot leak").
 *
 * We use WXT's `createShadowRootUi` for the lifecycle (it handles the CSS
 * injection, the `document_start` timing and the auto-cleanup on navigation),
 * and this module adds the pieces the spec cares about:
 *
 *  - the host element is a closed-ish, namespaced tag so page CSS cannot target
 *    it by accident;
 *  - our stylesheet is injected *into the shadow root only*, never into the page;
 *  - a focus trap + focus restoration for the pop-up (spec 3, keyboard a11y);
 *  - Esc-to-close, and dismissal when the page scrolls far away (spec 4.1);
 *  - a helper to build DOM without ever touching innerHTML.
 *
 * IMPORTANT (spec 9): the user's selected text and all dictionary content are
 * untrusted. `setText` and friends always use `textContent`.
 */

import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import type { ContentScriptContext } from "wxt/utils/content-script-context";

/** Namespace for all our DOM. Prefixed to avoid collisions with page CSS. */
export const NS = "es";

export const HOST_TAG = `${NS}-host`;

export interface ShadowUiOptions {
  /** Element name for the host. */
  readonly name: string;
  /** Stylesheet text injected into this shadow root. */
  readonly css: string;
  /** Called once, with the shadow root, every time the UI mounts. */
  readonly onMount: (root: ShadowRoot, host: HTMLElement) => void;
  /** Called when the UI unmounts (navigation, extension reload). */
  readonly onRemove?: () => void;
}

/**
 * Mounts a shadow-root UI and returns a small controller.
 * Re-mounting is automatic when the page SPA-navigates.
 */
export type ShadowUiController = ReturnType<typeof createShadowRootUi>;

export function mountShadowUi(
  ctx: ContentScriptContext,
  options: ShadowUiOptions,
): ShadowUiController {
  const ui = createShadowRootUi(ctx, {
    name: `${NS}-${options.name}`,
    position: "inline",
    anchor: "body",
    append: "last",
    onMount: (container) => {
      container.attachShadow({ mode: "open" });
      const shadow = container.shadowRoot;
      if (!shadow) return;
      shadow.appendChild(makeStyle(options.css));
      options.onMount(shadow, container);
    },
    // `exactOptionalPropertyTypes` is on, so an optional hook must be omitted
    // rather than passed as `undefined`.
    ...(options.onRemove ? { onRemove: options.onRemove } : {}),
  });

  return ui;
}

function makeStyle(css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = css;
  return style;
}

// ---------------------------------------------------------------------------
// DOM building without innerHTML
// ---------------------------------------------------------------------------

type Attrs = Record<string, string | number | boolean | null | undefined>;

export interface ElementSpec {
  readonly tag: string;
  readonly class?: string;
  readonly text?: string;
  readonly attrs?: Attrs;
  readonly children?: readonly (Node | string)[];
}

/**
 * Build an element safely. `text` is set with `textContent`, so any HTML in the
 * string is displayed literally and never parsed.
 */
export function el(spec: ElementSpec): HTMLElement {
  const node = document.createElement(spec.tag);
  if (spec.class) node.className = spec.class;
  if (spec.text !== undefined) node.textContent = spec.text;
  if (spec.attrs) {
    for (const [key, value] of Object.entries(spec.attrs)) {
      if (value === null || value === undefined || value === false) continue;
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of spec.children ?? []) {
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function frag(...children: readonly (Node | string)[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const child of children) {
    f.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return f;
}

// ---------------------------------------------------------------------------
// Focus management (spec 3: keyboard accessibility from the start)
// ---------------------------------------------------------------------------

/** Selectors that can hold focus inside a shadow root. */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function focusable(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  );
}

/**
 * Trap Tab inside `root` until the returned disposer is called.
 * Also remembers the previously focused element and restores it on dispose.
 */
export function trapFocus(root: HTMLElement): () => void {
  const previouslyFocused = document.activeElement as HTMLElement | null;

  // A host element's own `activeElement` is only meaningful once it has its own
  // shadow root; read it from the root node so this works for both cases.
  const activeIn = (): Element | null => {
    const inner = (root.getRootNode() as ShadowRoot).activeElement;
    return inner ?? document.activeElement;
  };

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab") return;
    const items = focusable(root);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;

    const active = activeIn();
    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  root.addEventListener("keydown", onKeydown);
  const initial = focusable(root)[0];
  initial?.focus();

  return () => {
    root.removeEventListener("keydown", onKeydown);
    previouslyFocused?.focus?.();
  };
}

/** True when focus is currently inside our shadow root. */
export function isFocusWithin(root: Node): boolean {
  const active = root.getRootNode() as ShadowRoot;
  return active instanceof ShadowRoot && active.activeElement !== null;
}

// ---------------------------------------------------------------------------
// Dismissal
// ---------------------------------------------------------------------------

/**
 * Call `onDismiss` on Esc, on a click outside, or when the anchor has scrolled
 * far away from the viewport (spec 4.1). Returns a disposer.
 */
export function watchForDismissal(
  shadow: ShadowRoot,
  anchorRect: () => DOMRect | null,
  onDismiss: () => void,
): () => void {
  const SCROLL_SLACK = 120;

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onDismiss();
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    const path = event.composedPath();
    if (path.includes(shadow.host)) return;
    onDismiss();
  };

  const onScroll = (): void => {
    const rect = anchorRect();
    if (!rect) {
      onDismiss();
      return;
    }
    // The anchor is gone from the viewport, or moved far away: hide.
    if (rect.bottom < -SCROLL_SLACK || rect.top > window.innerHeight + SCROLL_SLACK) {
      onDismiss();
    }
  };

  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("scroll", onScroll, true);

  return () => {
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("scroll", onScroll, true);
  };
}

// ---------------------------------------------------------------------------
// Positioning
// ---------------------------------------------------------------------------

export interface Placement {
  readonly left: number;
  readonly top: number;
}

/**
 * Place a box next to a selection rect, clamped inside the viewport with an 8 px
 * margin (spec 4.1: "kept inside the viewport").
 */
export function placeNear(
  anchor: DOMRect,
  box: { width: number; height: number },
  margin = 8,
): Placement {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer above the selection; flip below when there is no room.
  let top = anchor.top - box.height - 8;
  if (top < margin) top = anchor.bottom + 8;
  top = Math.min(Math.max(margin, top), Math.max(margin, vh - box.height - margin));

  let left = anchor.left + anchor.width / 2 - box.width / 2;
  left = Math.min(Math.max(margin, left), Math.max(margin, vw - box.width - margin));

  return { left: Math.round(left), top: Math.round(top) };
}

/** True when the event originated inside our own UI, so we ignore it (spec 5.1). */
export function isOwnEvent(event: Event, shadow: ShadowRoot): boolean {
  const path = event.composedPath();
  return path.includes(shadow.host);
}
