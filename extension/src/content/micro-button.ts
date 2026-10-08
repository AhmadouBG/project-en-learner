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

/* First-run tooltip, spec 4.1: "Click to practise this text", shown once. */
.es-tooltip {
  position: absolute;
  top: calc(${SIZE_PX}px + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: #202124;
  color: #fff;
  font: 12px/1.3 -apple-system, "Segoe UI", Roboto, sans-serif;
  padding: 5px 8px;
  border-radius: 4px;
  white-space: nowrap;
  pointer-events: none;
}

.es-tooltip::before {
  content: "";
  position: absolute;
  top: -4px;
  left: 50%;
  margin-left: -4px;
  border: 4px solid transparent;
  border-bottom-color: #202124;
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
  hide(): void;
  destroy(): void;
  /** The host element, so the watcher can ignore our own events. */
  readonly host: HTMLElement | null;
}

/** The four bars of the logo, matching the extension icon. */
function logoSvg(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");

  // Heights mirror the generated PNG icon: short, mid, tall, mid.
  const bars: readonly (readonly [number, number, number])[] = [
    [1.5, 7.5, 3],
    [5.5, 5.5, 5],
    [9.5, 3.5, 7],
  ];
  for (const [x, y, height] of bars) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", "2");
    rect.setAttribute("height", String(height));
    rect.setAttribute("fill", "currentColor");
    svg.appendChild(rect);
  }
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
          }

          buttonEl.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const chosen = selection;
            hide();
            if (chosen) options.onActivate(chosen);
          });

          // Esc to dismiss, and hide when the page scrolls the anchor away.
          stopDismissalWatcher = watchForDismissal(
            m2.shadow,
            () => selection?.rect ?? null,
            () => hide(),
          );

          return { container: m2.container };
        },
      });
  };

  return {
    async show(next: ResolvedSelection) {
      selection = next;
      if (!ui) await mount();
      if (!ui) return;

      ui.mount();

      const { width, height } = {
        width: SIZE_PX,
        height: options.tooltip ? SIZE_PX + 30 : SIZE_PX,
      };
      const at = placeNear(next.rect, { width, height });

      // Position the container, not the host: see the note on `.es-root`.
      ui.container.style.left = `${at.left}px`;
      ui.container.style.top = `${at.top}px`;

      // Focus the button so the shortcut and keyboard users can act on it.
      releaseFocus = trapFocus(ui.container);
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