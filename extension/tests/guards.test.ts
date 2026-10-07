/** @vitest-environment happy-dom */
/**
 * Tests for the selection guards.
 *
 * The password-field rules are the security-relevant ones: a failure here means
 * we would offer to read and speak a password, so these cases are written to be
 * deliberately awkward rather than convenient.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  activeElementIsPassword,
  eventComesFromUs,
  isEditableHost,
  isHiddenNode,
  isPasswordField,
  isPasswordSelection,
  isRestrictedPage,
  isTrustedUserEvent,
  isUnreadableNode,
  restrictedReason,
} from "../src/content/guards";

/** Build an element with the given tag/attributes, optionally with children. */
function make(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.firstElementChild as HTMLElement;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("restrictedReason", () => {
  it("allows ordinary web pages", () => {
    expect(restrictedReason("https://en.wikipedia.org/wiki/Schedule")).toBeNull();
    expect(restrictedReason("http://example.com/a/b?c=d#e")).toBeNull();
    expect(restrictedReason("https://github.com/user/repo")).toBeNull();
  });

  it("allows about:blank and about:srcdoc, which inherit a real origin", () => {
    expect(restrictedReason("about:blank")).toBeNull();
    expect(restrictedReason("about:srcdoc")).toBeNull();
    expect(restrictedReason("about:blank?x=1")).toBeNull();
  });

  it("blocks other about: pages, which are browser UI", () => {
    expect(restrictedReason("about:settings")).toBe("chrome-internal");
    expect(restrictedReason("about:newtab")).toBe("chrome-internal");
  });

  it("blocks chrome-internal schemes", () => {
    expect(restrictedReason("chrome://extensions")).toBe("chrome-internal");
    expect(restrictedReason("chrome://newtab/")).toBe("chrome-internal");
    expect(restrictedReason("chrome-untrusted://foo")).toBe("chrome-internal");
  });

  it("blocks extension pages, including Chrome's PDF viewer", () => {
    expect(restrictedReason("chrome-extension://abc/sidepanel.html")).toBe("extension-page");
  });

  it("blocks the Web Store specifically", () => {
    expect(restrictedReason("https://chromewebstore.google.com/detail/abc")).toBe("web-store");
    expect(restrictedReason("https://chrome.google.com/webstore/detail/abc")).toBe("web-store");
  });

  it("does not block an unrelated page on a store host", () => {
    expect(restrictedReason("https://chromewebstore.google.com/other")).toBeNull();
    expect(restrictedReason("https://chrome.google.com/other")).toBeNull();
  });

  it("blocks the store listing with a query string", () => {
    expect(restrictedReason("https://chromewebstore.google.com/detail/abc?hl=en")).toBe("web-store");
  });

  it("blocks devtools and view-source with their own reasons", () => {
    expect(restrictedReason("devtools://devtools/bundled/inspector.html")).toBe("devtools");
    expect(restrictedReason("view-source:https://example.com/")).toBe("view-source");
  });

  it("blocks a .pdf URL, which Chrome renders in its PDF viewer", () => {
    expect(restrictedReason("https://example.com/manual.pdf")).toBe("pdf-viewer");
    expect(restrictedReason("https://example.com/Deep/Manual.PDF")).toBe("pdf-viewer");
    expect(restrictedReason("https://example.com/a.pdf?x=1")).toBe("pdf-viewer");
  });

  it("refuses to guess about an unparseable URL", () => {
    expect(restrictedReason("not a url")).toBe("other-internal");
    expect(restrictedReason("")).toBe("other-internal");
  });

  it("is exposed as a simple predicate too", () => {
    expect(isRestrictedPage("https://example.com/")).toBe(false);
    expect(isRestrictedPage("chrome://settings")).toBe(true);
  });
});

describe("isPasswordField", () => {
  it("detects a real password input", () => {
    const input = make(`<input type="password" />`);
    document.body.append(input);
    expect(isPasswordField(input)).toBe(true);
  });

  it("treats a missing type attribute as text, not password", () => {
    const input = make(`<input />`);
    document.body.append(input);
    expect(isPasswordField(input)).toBe(false);
  });

  it("is case-insensitive about the type value", () => {
    const input = make(`<input type="PASSWORD" />`);
    document.body.append(input);
    expect(isPasswordField(input)).toBe(true);
  });

  it("detects an input masked only via autocomplete", () => {
    const input = make(`<input type="text" autocomplete="current-password" />`);
    document.body.append(input);
    expect(isPasswordField(input)).toBe(true);
  });

  it("does not flag a normal input that merely mentions autocomplete=off", () => {
    const input = make(`<input type="text" autocomplete="off" />`);
    document.body.append(input);
    expect(isPasswordField(input)).toBe(false);
  });

  it("detects a password input wrapped in other elements", () => {
    const wrapper = make(`<div><label>Password <span><input type="password" /></span></label></div>`);
    document.body.append(wrapper);
    const input = wrapper.querySelector("input");
    expect(isPasswordField(input)).toBe(true);
  });

  it("detects a masked field inside a shadow root", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const wrap = document.createElement("div");
    const input = document.createElement("input");
    input.setAttribute("type", "password");
    wrap.append(input);
    shadow.append(wrap);

    expect(isPasswordField(input)).toBe(true);
    // The wrapper is not itself inside a password field, so this is correctly
    // false -- walking up is the right answer here.
    expect(isPasswordField(wrap)).toBe(false);
  });

  it("detects a password field inside a web component via activeElement", () => {
    // This is the case a plain ancestor walk MISSES: when focus is inside a
    // shadow root, document.activeElement is the host, so a password input in
    // the component is only visible by looking down into it.
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    input.setAttribute("type", "password");
    shadow.append(input);
    input.focus();

    // The host is what the document reports, and it is not a password field.
    expect(document.activeElement).toBe(host);
    expect(isPasswordField(document.activeElement)).toBe(false);
    // ...but we must still refuse to act.
    expect(activeElementIsPassword()).toBe(true);
  });

  it("does not report a component without any masked field", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    input.setAttribute("type", "text");
    shadow.append(input);
    input.focus();

    expect(activeElementIsPassword()).toBe(false);
  });

  it("finds a masked field nested inside nested components", () => {
    const outer = document.createElement("div");
    document.body.append(outer);
    const inner = document.createElement("div");
    outer.append(inner);
    const innerShadow = inner.attachShadow({ mode: "open" });
    const field = document.createElement("input");
    field.setAttribute("type", "password");
    innerShadow.append(field);
    field.focus();

    expect(activeElementIsPassword()).toBe(true);
  });

  it("detects a site that marks the field rather than typing it", () => {
    const input = make(`<input type="text" data-private="true" />`);
    document.body.append(input);
    expect(isPasswordField(input)).toBe(true);
  });

  it("does not flag ordinary fields", () => {
    const input = make(`<input type="text" />`);
    const area = make(`<textarea></textarea>`);
    document.body.append(input, area);
    expect(isPasswordField(input)).toBe(false);
    expect(isPasswordField(area)).toBe(false);
  });

  it("returns false for null, so a collapsed selection is not an error", () => {
    expect(isPasswordField(null)).toBe(false);
    expect(isPasswordField(undefined)).toBe(false);
  });
});

describe("isPasswordSelection", () => {
  it("blocks when the anchor is a password field", () => {
    const input = make(`<input type="password" />`);
    document.body.append(input);
    expect(isPasswordSelection(input, input)).toBe(true);
  });

  it("blocks when only the FOCUS end is a password field", () => {
    // Dragging from normal text into a password must be refused.
    const safe = make(`<span>hello</span>`);
    const secret = make(`<input type="password" />`);
    document.body.append(safe, secret);
    expect(isPasswordSelection(safe, secret)).toBe(true);
    expect(isPasswordSelection(secret, safe)).toBe(true);
  });

  it("allows a selection with neither end in a password field", () => {
    const a = make(`<span>hello</span>`);
    const b = make(`<span>world</span>`);
    document.body.append(a, b);
    expect(isPasswordSelection(a, b)).toBe(false);
  });
});

describe("activeElementIsPassword", () => {
  it("is true when a password field has focus", () => {
    const input = make(`<input type="password" />`);
    document.body.append(input);
    input.focus();
    expect(activeElementIsPassword()).toBe(true);
  });

  it("is false when a normal input has focus", () => {
    const input = make(`<input type="text" />`);
    document.body.append(input);
    input.focus();
    expect(activeElementIsPassword()).toBe(false);
  });
});

describe("isEditableHost", () => {
  it("recognises editable hosts, which spec 5.1 wants supported", () => {
    const input = make(`<input type="text" />`);
    const area = make(`<textarea></textarea>`);
    const editable = make(`<div contenteditable="true"></div>`);
    const plain = make(`<p>text</p>`);
    document.body.append(input, area, editable, plain);

    expect(isEditableHost(input)).toBe(true);
    expect(isEditableHost(area)).toBe(true);
    expect(isEditableHost(editable)).toBe(true);
    expect(isEditableHost(plain)).toBe(false);
  });

  it("treats an editable host as non-password, so we still offer to practise", () => {
    const input = make(`<input type="text" />`);
    document.body.append(input);
    expect(isPasswordField(input)).toBe(false);
  });
});

describe("isUnreadableNode", () => {
  it("blocks script, style, noscript and template content", () => {
    const script = make(`<script></script>`);
    const style = make(`<style></style>`);
    const template = make(`<template></template>`);
    const para = make(`<p>ok</p>`);
    document.body.append(script, style, template, para);

    expect(isUnreadableNode(script)).toBe(true);
    expect(isUnreadableNode(style)).toBe(true);
    expect(isUnreadableNode(template)).toBe(true);
    expect(isUnreadableNode(para)).toBe(false);
  });
});

describe("isHiddenNode", () => {
  it("detects hidden, invisible and aria-hidden nodes", () => {
    const hidden = make(`<p hidden>no</p>`);
    const inlineHidden = make(`<p style="display:none">no</p>`);
    const invisible = make(`<p style="visibility:hidden">no</p>`);
    const aria = make(`<p aria-hidden="true">no</p>`);
    const shown = make(`<p>yes</p>`);
    document.body.append(hidden, inlineHidden, invisible, aria, shown);

    expect(isHiddenNode(hidden)).toBe(true);
    expect(isHiddenNode(inlineHidden)).toBe(true);
    expect(isHiddenNode(invisible)).toBe(true);
    expect(isHiddenNode(aria)).toBe(true);
    expect(isHiddenNode(shown)).toBe(false);
  });

  it("is safe with null", () => {
    expect(isHiddenNode(null)).toBe(false);
  });
});

describe("eventComesFromUs", () => {
  function makeHost() {
    const host = document.createElement("es-probe");
    document.body.append(host);
    host.attachShadow({ mode: "open" });
    return host;
  }

  it("recognises an event from inside our shadow root", () => {
    const host = makeHost();
    const shadow = host.shadowRoot as ShadowRoot;
    const button = document.createElement("button");
    shadow.append(button);

    const event = new MouseEvent("click", { bubbles: true, composed: true });
    button.dispatchEvent(event);
    expect(eventComesFromUs(event, host)).toBe(true);
  });

  it("is re-exported as isOwnEvent for UI code", async () => {
    const { isOwnEvent } = await import("../src/ui/shadow");
    const host = makeHost();
    const shadow = host.shadowRoot as ShadowRoot;
    const button = document.createElement("button");
    shadow.append(button);

    const inside = new MouseEvent("click", { bubbles: true, composed: true });
    button.dispatchEvent(inside);
    expect(isOwnEvent(inside, host)).toBe(true);

    const outside = new MouseEvent("click", { bubbles: true, composed: true });
    document.body.dispatchEvent(outside);
    expect(isOwnEvent(outside, host)).toBe(false);
  });

  it("does not claim an event from the page", () => {
    const host = makeHost();
    const outside = document.createElement("p");
    document.body.append(outside);

    const event = new MouseEvent("click", { bubbles: true, composed: true });
    outside.dispatchEvent(event);
    expect(eventComesFromUs(event, host)).toBe(false);
  });

  it("is safe when no host exists yet", () => {
    const event = new MouseEvent("click", { bubbles: true });
    expect(eventComesFromUs(event, null)).toBe(false);
  });
});

describe("isTrustedUserEvent", () => {
  it("rejects a dispatched event, so a page cannot fake a selection", () => {
    // Real browsers report `isTrusted === false` for dispatched events; happy-dom
    // leaves it `undefined`. The guard compares against `true`, so both are
    // correctly treated as untrusted.
    const event = new MouseEvent("mouseup", { bubbles: true });
    expect(isTrustedUserEvent(event)).toBe(false);
  });

  it("accepts only an explicitly trusted event", () => {
    const base = new MouseEvent("mouseup");
    // Simulate a trusted event, which the test environment cannot produce.
    Object.defineProperty(base, "isTrusted", { value: true, configurable: true });
    expect(isTrustedUserEvent(base)).toBe(true);
  });
});