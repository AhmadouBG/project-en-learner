/** @vitest-environment happy-dom */
/**
 * Tests for the selection reader's decision logic.
 *
 * The DOM-touching parts of `readSelection()` are verified end to end by
 * `scripts/check-selection.mjs` in a real browser, which is a stronger test than
 * a synthetic DOM can be. What is covered here is the pure decision layer:
 * whether a selection is allowed to become a practice target, and how that
 * target is built.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { isActionableSelection, targetFromSelection } from "../src/content/selection";

const PAGE = "https://en.wikipedia.org/wiki/Schedule";

function rect(): DOMRect {
  return { left: 100, top: 200, width: 80, height: 18 } as DOMRect;
}

function selection(text: string, anchor: Node | null, focus: Node | null = anchor) {
  return { text, rect: rect(), anchorNode: anchor, focusNode: focus };
}

function add(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host.firstElementChild as HTMLElement;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("isActionableSelection", () => {
  it("accepts ordinary text on an ordinary page", () => {
    const p = add("<p>Could you schedule it?</p>");
    expect(isActionableSelection(selection("Could you schedule it?", p), PAGE)).toBe(true);
  });

  it("refuses a browser surface", () => {
    const p = add("<p>text</p>");
    expect(isActionableSelection(selection("text", p), "chrome://settings")).toBe(false);
    expect(isActionableSelection(selection("text", p), "https://example.com/a.pdf")).toBe(false);
  });

  it("refuses a password field at either end of the selection", () => {
    const pw = add(`<input type="password" />`);
    const text = add("<span>hello</span>");
    expect(isActionableSelection(selection("secret", pw), PAGE)).toBe(false);
    expect(isActionableSelection(selection("secret", text, pw), PAGE)).toBe(false);
    expect(isActionableSelection(selection("secret", pw, text), PAGE)).toBe(false);
  });

  it("refuses when a password field merely has focus", () => {
    const pw = add(`<input type="password" />`);
    pw.focus();
    const p = add("<p>text</p>");
    expect(isActionableSelection(selection("text", p), PAGE)).toBe(false);
  });

  it("accepts an editable text field, which spec 5.1 wants supported", () => {
    const input = add(`<input type="text" />`);
    expect(isActionableSelection(selection("some comment", input), PAGE)).toBe(true);
  });

  it("refuses script and style content", () => {
    const script = add("<script></script>");
    expect(isActionableSelection(selection("var x = 1;", script), PAGE)).toBe(false);
  });

  it("refuses hidden content", () => {
    const hidden = add(`<p hidden>invisible</p>`);
    expect(isActionableSelection(selection("invisible", hidden), PAGE)).toBe(false);
  });

  it("refuses text with nothing to speak", () => {
    const p = add("<p>|||</p>");
    expect(isActionableSelection(selection("|||", p), PAGE)).toBe(false);
  });

  it("allows about:blank, which inherits a real origin", () => {
    const p = add("<p>text</p>");
    expect(isActionableSelection(selection("text", p), "about:blank")).toBe(true);
  });
});

describe("targetFromSelection", () => {
  it("carries accent and speed through unchanged (spec 2)", () => {
    const p = add("<p>text</p>");
    const target = targetFromSelection(selection("schedule", p), "en-GB", 0.75);

    expect(target).toEqual({
      text: "schedule",
      kind: "word",
      accent: "en-GB",
      speed: 0.75,
    });
  });

  it("classifies multi-word text as a sentence", () => {
    const p = add("<p>text</p>");
    expect(targetFromSelection(selection("Could you schedule it?", p), "en-US", 1).kind).toBe(
      "sentence",
    );
  });

  it("does not mark an ordinary selection as truncated", () => {
    const p = add("<p>text</p>");
    expect(targetFromSelection(selection("schedule", p), "en-US", 1).truncated).toBeUndefined();
  });
});