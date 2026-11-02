/**
 * The micro-button (spec 4.1): a 28 px round button that appears next to the
 * selection.
 *
 * Lives in a shadow root so page CSS cannot style it and ours cannot leak
 * (spec 3). Nothing is injected until the first selection is accepted, which is
 * what keeps spec 9's "no work on pages until the user selects text" true.
 *
 * The logo is inline SVG rather than a packaged PNG: an SVG needs no
 * `web_accessible_resources` entry, survives a strict page CSP, and scales
 * cleanly at 16-28 px.
 */

import { el, placeNear, trapFocus, watchForDismissal, type ShadowUiController } from "../ui/shadow";
import type { ContentScriptContext } from "wxt/utils/content-script-context";
import type { ResolvedSelection } from "./selection";

/** Spec 4.1: 28 px round button. */
const SIZE_PX = 28;

/** Green accent carried over from the previous panel. */
const GREEN = "#4caf50";
const GREEN_DARK = "#056b16";

const CSS = `
/*
 * The host is left untouched on purpose: WXT applies
 * \`:host { all: initial !important }\`, and \`all\` includes \`position\`, so
 * positioning the host from outside is silently overridden (verified in Chrome:
 * the host computed as \`position: static\`). Everything positional therefore
 * lives on the container, inside the shadow root, where our own CSS wins.
 *
 * left/top are written inline by show(); they are not !important because nothing
 * competes with them here.
 */
.es-root {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2147483647;
  /* Do not swallow page clicks; only our own UI is interactive. */
  pointer-events: none;
}

.es-root > * { pointer-events: auto; }

.es-button {
  width: ${SIZE_PX}px;
  height: ${SIZE_PX}px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: ${GREEN};
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
  transition: background 0.15s ease, transform 0.1s ease;
}

.es-button:hover { background: ${GREEN_DARK}; }
.es-button:active { transform: scale(0.94); }

/* Visible focus ring (spec 3), drawn inside the button so it is not clipped. */
.es-button:focus-visible {
  outline: 2px solid #0b57d0;
  outline-offset: 2px;
}

.es-button svg { display: block; pointer-events: none; }

/* First-run tooltip, spec 4.1: "Click to practise this text", shown once.
 *
 * It must open AWAY from the selection. The button normally sits above the text,
 * so a tooltip hanging below it would land on top of the words just selected --
 * exactly when the user wants to read them. The --above modifier is applied at
 * runtime to match whichever side the button ended up on.
 */
.es-tooltip {
  position: absolute;
  top: calc(${SIZE_PX}px + 6px);
  /* Right-aligned to the button rather than centred. The button is itself
     right-aligned to the selection, so a centred tooltip would hang out past the
     end of the text. */
  right: 0;
  background: #202124;
  color: #fff;
  font: 12px/1.3 -apple-system, "Segoe UI", Roboto, sans-serif;
  padding: 5px 8px;
  border-radius: 4px;
  white-space: nowrap;
  pointer-events: none;
}

/* Arrow, pointing away from the button in whichever direction it opens. */
.es-tooltip::before {
  content: "";
  position: absolute;
  top: -4px;
  /* Arrow sits over the button, which is at the tooltip's right edge. */
  right: 8px;
  border: 4px solid transparent;
  border-bottom-color: #202124;
}

/* Button above the selection: open the tooltip upward, clear of the text. */
.es-tooltip--above {
  top: auto;
  bottom: calc(${SIZE_PX}px + 6px);
}

.es-tooltip--above::before {
  top: auto;
  bottom: -4px;
  border-bottom-color: transparent;
  border-top-color: #202124;
}

@media (prefers-reduced-motion: reduce) {
  .es-button { transition: none; }
}
`;

export interface MicroButtonOptions {
  /** Localised label, e.g. "Practise this text". */
  readonly label: string;
  /** Localised first-run tooltip; pass null once it has been shown. */
  readonly tooltip: string | null;
  /** Called when the user activates the button. */
  readonly onActivate: (selection: ResolvedSelection) => void;
  /** Called when the UI hides for any reason. */
  readonly onDismiss: () => void;
}

export interface MicroButtonController {
  /** Show next to the given selection, clamped inside the viewport. */
  show(selection: ResolvedSelection): Promise<void>;
  /**
   * Follow the selection after a scroll. `null` means the text has left the
   * viewport, so hide rather than clamp to a screen edge.
   */
  follow(selection: ResolvedSelection | null): void;
  hide(): void;
  destroy(): void;
  /** The host element, so the watcher can ignore our own events. */
  readonly host: HTMLElement | null;
}

export function getEqualizerMarkup(iconColor: string): string {
  return `<rect x="23" y="40" width="10" height="20" rx="5" fill="${iconColor}" />
  <rect x="38" y="29" width="10" height="42" rx="5" fill="${iconColor}" />
  <rect x="53" y="20" width="10" height="60" rx="5" fill="${iconColor}" />
  <rect x="68" y="35" width="10" height="30" rx="5" fill="${iconColor}" />`;
}

export function createEqualizerSvg(backgroundColor: string, iconColor: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img">
  <rect width="100" height="100" rx="22" fill="${backgroundColor}" />
  ${getEqualizerMarkup(iconColor)}
</svg>`;
}

/** The four bars of the logo, matching the extension icon. */
function logoSvg(): SVGElement {
  const parser = new DOMParser();
  const doc = parser.parseFromString(
    createEqualizerSvg("none", "currentColor"),
    "image/svg+xml",
  );
  const svg = doc.documentElement as unknown as SVGElement;
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

/**
 * Build the micro-button controller.
 *
 * Synchronous on purpose: nothing is mounted until the first accepted
 * selection (spec 9, "no work on pages until the user selects text"), and the
 * mount itself is async because WXT fetches CSS. `show()` awaits it.
 */
export function createMicroButton(
  ctx: ContentScriptContext,
  options: MicroButtonOptions,
): MicroButtonController {
  let ui: ShadowUiController<{ container: HTMLElement }> | null = null;
  let selection: ResolvedSelection | null = null;
  let tooltip: HTMLElement | null = null;
  let releaseFocus: (() => void) | null = null;
  let stopDismissalWatcher: (() => void) | null = null;

  const hide = () => {
    if (!ui) return;
    selection = null;
    stopDismissalWatcher?.();
    stopDismissalWatcher = null;
    releaseFocus?.();
    releaseFocus = null;
    ui.remove();
    options.onDismiss();
  };

  const mount = async (): Promise<void> => {
    const { mountShadowUi } = await import("../ui/shadow");
    ui = await mountShadowUi(ctx, {
      name: "micro-button",
      css: CSS,
      onMount: (m2) => {
        // Local consts first, so the click handler does not have to cope with
        // outer mutable references being null.
        m2.container.classList.add("es-root");

        const buttonEl = el({ tag: "button", class: "es-button" }) as HTMLButtonElement;
        buttonEl.type = "button";
        buttonEl.setAttribute("aria-label", options.label);
        buttonEl.title = options.label;
        buttonEl.appendChild(logoSvg());
        m2.container.appendChild(buttonEl);

        if (options.tooltip) {
          const tip = el({ tag: "div", class: "es-tooltip", text: options.tooltip });
          m2.container.appendChild(tip);
          tooltip = tip;
        }

        buttonEl.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const chosen = selection;
          hide();
          if (chosen) options.onActivate(chosen);
        });

        // Esc to dismiss, and hide as soon as the page scrolls. The button is
        // position:fixed so it cannot follow the text, so scrolling would leave
        // it stranded pointing at unrelated words.
        stopDismissalWatcher = watchForDismissal(
          m2.shadow,
          () => selection?.rect ?? null,
          () => hide(),
          { onScroll: "never" },
        );

        return { container: m2.container };
      },
    });
  };

  /**
   * Position the button directly above the right-hand end of the selection.
   *
   * The horizontal anchor is the BUTTON's own width, never the tooltip's. Using
   * the tooltip width here pushed the button ~150 px to the left of the words,
   * because the tooltip is a sibling that overhangs to the left (see
   * `.es-tooltip` in the CSS above). The button is what must sit on the end of the
   * selection; the tooltip is decoration hanging off it.
   */
  const place = (next: ResolvedSelection): void => {
    if (!ui) return;

    // The tooltip makes the box taller so we do not flip below when there is only
    // 28 px of room above, but it must not affect the horizontal anchor.
    const height = options.tooltip ? SIZE_PX + 30 : SIZE_PX;

    const at = placeNear(next.rect, { width: SIZE_PX, height }, 8, "right");
    let left = at.left;

    // The tooltip overhangs to the left of the button, so if the selection ends
    // near the left edge of the viewport it would run off-screen. In that one case
    // we shift the button right, trading a few pixels of anchoring for a readable
    // tooltip. It only ever happens on the first run.
    const tooltipWidth = tooltip?.offsetWidth ?? 0;
    if (tooltipWidth > 0 && left - tooltipWidth < 8) {
      left = Math.min(8 + tooltipWidth, window.innerWidth - SIZE_PX - 8);
    }

    // Position the container, not the host: see the note on `.es-root`.
    ui.container.style.left = `${left}px`;
    ui.container.style.top = `${at.top}px`;

    // The tooltip must open away from the selected text.
    if (tooltip) {
      tooltip.classList.toggle("es-tooltip--above", at.placement === "above");
    }
  };

  return {
    async show(next: ResolvedSelection) {
      selection = next;
      if (!ui) await mount();
      if (!ui) return;

      ui.mount();
      place(next);

      // Focus the button so the shortcut and keyboard users can act on it.
      releaseFocus = trapFocus(ui.container);
    },

    /**
     * Re-place the button because the page scrolled.
     *
     * Called with fresh geometry on every scroll event, so the button stays
     * attached to the selected words instead of being left behind pointing at
     * whatever text has since scrolled under it. Passing `null` means the text
     * has left the viewport, so there is nothing to point at.
     */
    follow(next: ResolvedSelection | null) {
      if (!ui) return;
      if (!next) {
        hide();
        return;
      }
      selection = next;
      place(next);
    },

    hide,

    destroy() {
      stopDismissalWatcher?.();
      releaseFocus?.();
      ui?.remove();
      ui = null;
    },

    get host() {
      return ui?.host ?? null;
    },
  };
}