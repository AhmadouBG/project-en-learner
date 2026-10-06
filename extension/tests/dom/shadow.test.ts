/** @vitest-environment happy-dom */
/**
 * Tests for the shadow-DOM helpers.
 *
 * These matter for correctness, not just coverage:
 *  - `el()` must never parse HTML, because selected page text and dictionary
 *    responses are untrusted (spec 9);
 *  - `placeNear()` must keep the micro-button inside the viewport (spec 4.1);
 *  - the focus trap must restore focus on dispose (spec 3).
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  el,
  focusable,
  frag,
  isOwnEvent,
  placeNear,
  trapFocus,
  watchForDismissal,
} from "../../src/ui/shadow";

describe("el", () => {
  it("sets text as textContent, never as markup", () => {
    const node = el({ tag: "span", text: "<img src=x onerror=alert(1)>" });
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("drops null/undefined/false attributes and keeps true as an empty attr", () => {
    const node = el({
      tag: "div",
      attrs: { id: "keep", title: null, "data-x": undefined, hidden: false, disabled: true },
    });
    expect(node.getAttribute("id")).toBe("keep");
    expect(node.hasAttribute("title")).toBe(false);
    expect(node.hasAttribute("data-x")).toBe(false);
    expect(node.hasAttribute("hidden")).toBe(false);
    expect(node.getAttribute("disabled")).toBe("");
  });

  it("appends child nodes and text nodes", () => {
    const child = document.createElement("b");
    const node = el({ tag: "p", children: [child, " tail"] });
    expect(node.childNodes).toHaveLength(2);
    expect(node.textContent).toContain("tail");
  });
});

describe("frag", () => {
  it("builds a fragment from nodes and strings", () => {
    const f = frag(document.createElement("i"), "x");
    expect(f.childNodes).toHaveLength(2);
  });
});

describe("focusable", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("lists focusable elements and skips disabled ones", () => {
    document.body.appendChild(
      el({
        tag: "div",
        children: [
          el({ tag: "button", attrs: { id: "ok" } }),
          el({ tag: "button", attrs: { id: "no", disabled: true } }),
          el({ tag: "input" }),
        ],
      }),
    );
    const ids = focusable(document.body).map((n) => n.id || n.tagName.toLowerCase());
    expect(ids).toContain("ok");
    expect(ids).toContain("input");
    expect(ids).not.toContain("no");
  });
});

describe("trapFocus", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("focuses the first focusable element on mount", () => {
    document.body.appendChild(
      el({
        tag: "div",
        attrs: { id: "host" },
        children: [el({ tag: "button", attrs: { id: "a" } }), el({ tag: "button", attrs: { id: "b" } })],
      }),
    );
    const dispose = trapFocus(document.getElementById("host") as HTMLElement);
    expect(document.activeElement?.id).toBe("a");
    dispose();
  });

  it("wraps Tab from the last element back to the first", () => {
    const host = el({
      tag: "div",
      children: [el({ tag: "button", attrs: { id: "a" } }), el({ tag: "button", attrs: { id: "b" } })],
    });
    document.body.appendChild(host);
    trapFocus(host);

    (document.getElementById("b") as HTMLElement).focus();
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("a");
  });

  it("wraps Shift+Tab from the first element to the last", () => {
    const host = el({
      tag: "div",
      children: [el({ tag: "button", attrs: { id: "a" } }), el({ tag: "button", attrs: { id: "b" } })],
    });
    document.body.appendChild(host);
    trapFocus(host);

    (document.getElementById("a") as HTMLElement).focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    host.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe("b");
  });

  it("restores focus to the previously focused element on dispose", () => {
    const opener = el({ tag: "button", attrs: { id: "opener" } });
    document.body.appendChild(opener);
    opener.focus();

    const host = el({ tag: "div", children: [el({ tag: "button", attrs: { id: "a" } })] });
    document.body.appendChild(host);

    const dispose = trapFocus(host);
    expect(document.activeElement?.id).toBe("a");

    dispose();
    expect(document.activeElement?.id).toBe("opener");
  });
});

describe("placeNear", () => {
  const box = { width: 28, height: 28 };
  const viewport = (w: number, h: number) => {
    Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
  };
  const rect = (left: number, top: number, width = 100, height = 18): DOMRect =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;

  it("centres horizontally above the selection by default", () => {
    viewport(1000, 800);
    const p = placeNear(rect(400, 300), box);
    expect(p.left).toBe(400 + 50 - 14);
    expect(p.top).toBe(300 - 28 - 8);
  });

  it("flips below when there is no room above", () => {
    viewport(1000, 800);
    const p = placeNear(rect(400, 4), box);
    expect(p.top).toBe(4 + 18 + 8);
  });

  it("clamps inside the left edge", () => {
    viewport(1000, 800);
    // Selection starts off-screen to the left, so the centred position would be
    // negative and has to be clamped to the margin.
    expect(placeNear(rect(-200, 300), box).left).toBe(8);
  });

  it("leaves an already-visible left position alone", () => {
    viewport(1000, 800);
    // Centring puts the 28 px button at x = 50 - 14 = 36, which is already
    // inside the viewport, so it must not be snapped to the margin.
    expect(placeNear(rect(0, 300), box).left).toBe(36);
  });

  it("clamps inside the right edge", () => {
    viewport(300, 800);
    expect(placeNear(rect(280, 300), box).left).toBe(300 - 28 - 8);
  });

  it("stays inside a viewport shorter than the box", () => {
    viewport(200, 20);
    const p = placeNear(rect(10, 5), box);
    expect(p.top).toBe(8);
    expect(p.left).toBeGreaterThanOrEqual(8);
  });
});

describe("watchForDismissal", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  function makeHost() {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" });
    const shadow = host.shadowRoot as ShadowRoot;
    return { host, shadow };
  }

  it("dismisses on Escape", () => {
    const { host, shadow } = makeHost();
    let dismissed = 0;
    watchForDismissal(shadow, () => null, () => (dismissed += 1));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dismissed).toBe(1);
    expect(host.isConnected).toBe(true);
  });

  it("ignores clicks that originate inside our own UI", () => {
    const { shadow } = makeHost();
    let dismissed = 0;
    watchForDismissal(shadow, () => null, () => (dismissed += 1));

    const button = document.createElement("button");
    shadow.appendChild(button);
    button.addEventListener("click", () => undefined);
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));

    expect(dismissed).toBe(0);
  });

  it("dismisses on a click outside", () => {
    const { shadow } = makeHost();
    let dismissed = 0;
    watchForDismissal(shadow, () => null, () => (dismissed += 1));

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(dismissed).toBe(1);
  });

  it("dismisses when the anchor scrolls far away", () => {
    const { shadow } = makeHost();
    let dismissed = 0;
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const farRect = { bottom: -500, top: -520 } as DOMRect;
    watchForDismissal(shadow, () => farRect, () => (dismissed += 1));

    window.dispatchEvent(new Event("scroll"));
    expect(dismissed).toBe(1);
  });

  it("stays put while the anchor is still on screen", () => {
    const { shadow } = makeHost();
    let dismissed = 0;
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    const nearRect = { bottom: 300, top: 280 } as DOMRect;
    watchForDismissal(shadow, () => nearRect, () => (dismissed += 1));

    window.dispatchEvent(new Event("scroll"));
    expect(dismissed).toBe(0);
  });

  it("stops listening after dispose", () => {
    const { shadow } = makeHost();
    let dismissed = 0;
    const dispose = watchForDismissal(shadow, () => null, () => (dismissed += 1));
    dispose();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(dismissed).toBe(0);
  });
});

describe("isOwnEvent", () => {
  it("recognises events from inside our shadow root", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" });
    const shadow = host.shadowRoot as ShadowRoot;
    const button = document.createElement("button");
    shadow.appendChild(button);

    const event = new MouseEvent("click", { bubbles: true, composed: true });
    button.dispatchEvent(event);
    expect(isOwnEvent(event, shadow)).toBe(true);
  });

  it("does not claim page events", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" });
    const shadow = host.shadowRoot as ShadowRoot;
    const outside = document.createElement("p");
    document.body.appendChild(outside);

    const event = new MouseEvent("click", { bubbles: true, composed: true });
    outside.dispatchEvent(event);
    expect(isOwnEvent(event, shadow)).toBe(false);
  });
});