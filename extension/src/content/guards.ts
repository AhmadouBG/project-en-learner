/**
 * Selection guards (spec 3, 5.1; spec 3 acceptance: "does not appear on
 * password fields").
 *
 * Like `normalize.ts`, this module is DOM-only and free of WXT imports, so it
 * can be unit tested directly. It contains no I/O and logs nothing: spec 9 says
 * never log the user's text or audio, and a guard is exactly the code that sees
 * user input.
 *
 * The rules, in the order a selection meets them:
 *   1. never act on a password field;
 *   2. never act on a page we are not allowed to touch;
 *   3. never react to our own UI or to synthetic events;
 *   4. otherwise the selection is the user's to practise.
 */

/** Why a page is off limits, so the UI can localise the explanation. */
export type RestrictedReason =
  | "chrome-internal"
  | "extension-page"
  | "web-store"
  | "pdf-viewer"
  | "devtools"
  | "view-source"
  | "other-internal";

/** Schemes that are browser surfaces rather than web content. */
const INTERNAL_SCHEMES = [
  "chrome:",
  "chrome-untrusted:",
  "chrome-search:",
  "chrome-native:",
  "devtools:",
  "edge:",
  "resource:",
  "view-source:",
  "moz-extension:",
] as const;

/**
 * Extension store hosts, and the path prefix each one actually uses.
 *
 * Chrome migrated the store from `chrome.google.com/webstore/...` to
 * `chromewebstore.google.com/detail/...`, so both shapes are listed. Matching
 * on the old prefix alone would have let the current store through.
 */
const WEB_STORE_PATHS: readonly (readonly [string, string])[] = [
  ["chromewebstore.google.com", "/detail"],
  ["chrome.google.com", "/webstore"],
  ["microsoftedge.microsoft.com", "/en-us/edgeaddons"],
];

/**
 * Classify a URL, or return `null` when it is ordinary web content we may act
 * on.
 *
 * `about:blank` is deliberately allowed: it is a real, scriptable document that
 * inherits its parent's origin, and our manifest's `match_origin_as_fallback`
 * deliberately targets it. `about:srcdoc` is handled by the same rule. Every
 * other `about:` page is browser UI.
 */
export function restrictedReason(url: string): RestrictedReason | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A URL we cannot parse is not one we should act on.
    return "other-internal";
  }

  const scheme = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();

  if (scheme === "about:") {
    const isInheriting = /^(about:blank|about:srcdoc|about:blank\?)/.test(url.toLowerCase());
    return isInheriting ? null : "chrome-internal";
  }

  if (scheme === "chrome-extension:" || scheme === "moz-extension:") return "extension-page";

  for (const internal of INTERNAL_SCHEMES) {
    if (scheme !== internal) continue;
    if (scheme === "devtools:") return "devtools";
    if (scheme === "view-source:") return "view-source";
    return "chrome-internal";
  }

  for (const [storeHost, prefix] of WEB_STORE_PATHS) {
    if (host === storeHost && parsed.pathname.startsWith(prefix)) return "web-store";
  }

  // Chrome renders PDFs in an extension page but keeps the original URL, so the
  // extension must exclude them by extension, not by scheme.
  if (parsed.pathname.toLowerCase().endsWith(".pdf")) return "pdf-viewer";

  return null;
}

/** Convenience predicate for the common case. */
export function isRestrictedPage(url: string): boolean {
  return restrictedReason(url) !== null;
}

// ---------------------------------------------------------------------------
// Password fields
// ---------------------------------------------------------------------------

/** Resolve a possibly-text node to the element that owns it. */
function resolveElement(node: Node | null | undefined): Element | null {
  if (!node) return null;
  if (node.nodeType === 1 /* ELEMENT_NODE */) return node as Element;
  return (node as Partial<Element>).parentElement ?? null;
}

/**
 * Walk from `node` up through its ancestors, crossing shadow boundaries.
 *
 * A selection inside a web component is reported with nodes inside the
 * component's shadow tree, whose host is in the page. Stopping at the first
 * shadow boundary would let a masked input inside a component slip through.
 */
function* ancestors(node: Node): Generator<Element> {
  let current: Element | null = resolveElement(node);
  let guard = 0;
  while (current && guard < 100) {
    yield current;
    guard += 1;
    current = current.parentElement ?? shadowHostOf(current);
  }
}

/**
 * If `el` sits inside a shadow tree, return the host element that owns it;
 * otherwise `null`.
 *
 * Duck-types the shadow root instead of using `instanceof ShadowRoot`, because a
 * node from an iframe's document fails `instanceof` against our realm's
 * constructor.
 */
function shadowHostOf(el: Element): Element | null {
  const root: unknown = el.getRootNode();
  if (root === null || typeof root !== "object" || !("host" in root)) return null;
  const host: unknown = root.host;
  return host instanceof Element ? host : null;
}

/** Does this element own a shadow root, i.e. is it a shadow host? */
function isShadowHost(el: Element): boolean {
  return "shadowRoot" in el && el.shadowRoot !== null;
}

/** Does this element itself look like a masked field? */
function isMaskedElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();

  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (type === "password") return true;
    const autocomplete = (el.getAttribute("autocomplete") ?? "").toLowerCase();
    if (autocomplete.includes("password")) return true;
  }

  // Some sites mask via a class or a data attribute instead of type=password.
  const className = el.getAttribute("class") ?? "";
  const dataPrivate = el.getAttribute("data-private") ?? "";
  return /\bpassword\b/i.test(className) || dataPrivate.toLowerCase() === "true";
}

/**
 * Is this node inside a password field?
 *
 * Covers the two real ways sites do this:
 *  - a genuine `<input type="password">`;
 *  - `autocomplete="...password..."` on a differently-typed input, which is what
 *    password managers and some frameworks produce.
 *
 * Sites that mask a plain text input with `-webkit-text-security` cannot be
 * detected from the DOM. That is a known limitation, recorded in DECISIONS.md;
 * we still never *read* the text of a detected password field.
 */
export function isPasswordField(node: Node | null | undefined): boolean {
  if (!node) return false;
  for (const el of ancestors(node)) {
    if (isMaskedElement(el)) return true;
  }
  return false;
}

/**
 * Does this element contain a masked field, looking INSIDE its shadow root?
 *
 * This direction matters and is not the same as the ancestor walk. When focus is
 * inside a shadow root, `document.activeElement` returns the shadow HOST, not the
 * focused element, so walking upwards from it finds nothing and a password input
 * inside a web component would be missed. We therefore have to descend.
 */
export function containsMaskedField(el: Element | null | undefined): boolean {
  if (!el) return false;
  if (isMaskedElement(el)) return true;

  // Only a shadow host can hide a masked field from us; if this element already
  // sits inside someone else's shadow tree, that host's own check covers it.
  if (shadowHostOf(el) !== null) return false;
  if (!isShadowHost(el)) return false;

  // A field may be nested several components deep, so walk every host we find.
  const queue: Element[] = Array.from(el.shadowRoot?.querySelectorAll("*") ?? []);
  let guard = 0;
  while (queue.length > 0 && guard < 5000) {
    guard += 1;
    const candidate = queue.shift();
    if (!candidate) continue;
    if (isMaskedElement(candidate)) return true;
    if ("shadowRoot" in candidate && candidate.shadowRoot !== null) {
      queue.push(...Array.from(candidate.shadowRoot.querySelectorAll("*")));
    }
  }
  return false;
}

/**
 * A selection is unsafe if EITHER end sits in a password field. Dragging from a
 * normal field into a password field must not be practised.
 */
export function isPasswordSelection(
  anchor: Node | null | undefined,
  focus: Node | null | undefined,
): boolean {
  return isPasswordField(anchor) || isPasswordField(focus);
}

/**
 * Is the focused element a password field?
 *
 * Checked in addition to the selection endpoints because a page can move focus
 * to a password field while the selection endpoints still point at ordinary
 * text; the two together are stricter than either alone.
 *
 * Uses `containsMaskedField` rather than `isPasswordField` because
 * `document.activeElement` is the shadow HOST when focus sits inside a shadow
 * root, so a password input inside a web component is only visible if we look
 * down into the component as well as up.
 */
export function activeElementIsPassword(): boolean {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return containsMaskedField(active);
}

// ---------------------------------------------------------------------------
// Editable fields (supported, unlike passwords)
// ---------------------------------------------------------------------------

/**
 * Spec 5.1 wants editable fields supported, e.g. selecting part of what you are
 * typing into a comment box. Passwords are the only exclusion.
 */
export function isEditableHost(node: Node | null | undefined): boolean {
  if (!node) return false;
  for (const el of ancestors(node)) {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea" || tag === "input") return true;
    // `isContentEditable` is on HTMLElement, not Element.
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    if ((el.getAttribute("contenteditable") ?? "").toLowerCase() === "true") return true;
  }
  return false;
}

/** True when the selection sits in something we should not read at all. */
export function isUnreadableNode(node: Node | null | undefined): boolean {
  const el = resolveElement(node);
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  return tag === "script" || tag === "style" || tag === "noscript" || tag === "template";
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Did this event originate inside our own shadow-root UI?
 *
 * Spec 5.1: "Ignore events that originate inside our own UI." Without this,
 * clicking the micro-button would look like a new selection and re-trigger the
 * whole flow.
 */
export function eventComesFromUs(event: Event, host: Element | null): boolean {
  if (!host) return false;
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  return path.includes(host);
}

/**
 * Reject synthetic events. `isTrusted === false` means a script dispatched it,
 * either the page or another extension. We only react to genuine user gestures,
 * so a page cannot fake a selection by dispatching its own `mouseup`.
 *
 * Compared against `true` rather than returned directly, because
 * `Event.isTrusted` is a boolean in browsers but is simply `undefined` in some
 * DOM implementations used for testing. Anything not explicitly trusted is
 * untrusted.
 */
export function isTrustedUserEvent(event: Event): boolean {
  return event.isTrusted === true;
}

/**
 * True when a node is not rendered, so a selection there is invisible to the
 * user and there is nothing to point the button at.
 */
export function isHiddenNode(node: Node | null | undefined): boolean {
  const el = resolveElement(node);
  if (!el || typeof el.getAttribute !== "function") return false;
  if (el.hasAttribute("hidden")) return true;
  const style = (el as HTMLElement).style;
  if (style?.display === "none" || style?.visibility === "hidden") return true;
  if ((el.getAttribute("aria-hidden") ?? "") === "true") return true;
  return false;
}