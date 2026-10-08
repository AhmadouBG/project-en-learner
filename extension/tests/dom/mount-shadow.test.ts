/** @vitest-environment happy-dom */
/**
 * Tests for `mountShadowUi`.
 *
 * These exist because the first version of this wrapper was wrong in two ways
 * that TypeScript did not catch, because the content script never mounted UI
 * during Phase 1:
 *
 *   1. `createShadowRootUi` is async (WXT fetches the entrypoint CSS), so the
 *      wrapper has to await it.
 *   2. WXT already creates the shadow root, and `onMount` receives
 *      `(container, shadow, host)`. Calling `attachShadow()` again on the
 *      container throws, because the container already lives inside WXT's root.
 *
 * So we mock WXT and assert the contract our wrapper relies on.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const createShadowRootUi = vi.fn<(...args: unknown[]) => Promise<FakeController>>();

vi.mock("wxt/utils/content-script-ui/shadow-root", () => ({
  createShadowRootUi: (ctx: unknown, options: unknown): Promise<FakeController> =>
    createShadowRootUi(ctx, options),
}));

const { mountShadowUi, styleSheet } = await import("../../src/ui/shadow");

/** Minimal stand-in for WXT's resolved controller. */
// Declared before use so the mock factory below can reference the type.
interface FakeController {
  mount: () => void;
  remove: () => void;
  autoMount: (options?: unknown) => void;
  mounted: unknown;
  shadowHost: HTMLElement;
  uiContainer: HTMLElement;
  shadow: ShadowRoot;
}

function fakeController(): FakeController {
  const host = document.createElement("es-probe");
  const shadow = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  shadow.append(container);

  let mounted: unknown;
  return {
    mount: () => {
      mounted = onMountSpy?.(container, shadow, host);
    },
    remove: () => undefined,
    autoMount: () => undefined,
    get mounted() {
      return mounted;
    },
    shadowHost: host,
    uiContainer: container,
    shadow,
  };
}

let onMountSpy: ((c: HTMLElement, s: ShadowRoot, h: HTMLElement) => unknown) | undefined;

beforeEach(() => {
  createShadowRootUi.mockReset();
  onMountSpy = undefined;
  createShadowRootUi.mockImplementation(async (_ctx: unknown, options: unknown) => {
    onMountSpy = (options as { onMount: typeof onMountSpy }).onMount;
    return fakeController();
  });
});

// `defineContentScript` context is only passed through untouched.
const ctx = { onInvalidated: () => {} } as never;

describe("mountShadowUi", () => {
  it("awaits WXT's async factory instead of returning a promise of a controller", async () => {
    const controller = await mountShadowUi(ctx, {
      name: "probe",
      css: ".a{}",
      onMount: () => undefined,
    });

    expect(typeof controller.mount).toBe("function");
    expect(typeof controller.remove).toBe("function");
    // The bug: this used to be a Promise, so `.mount` was undefined.
    expect(controller.mount).not.toBeInstanceOf(Promise);
  });

  it("namespaces the host element", async () => {
    await mountShadowUi(ctx, { name: "probe", css: ".a{}", onMount: () => undefined });
    const options = createShadowRootUi.mock.calls[0]?.[1] as { name: string };
    expect(options.name).toBe("es-probe");
  });

  it("does not attach a second shadow root", async () => {
    let shadowIsRoot = false;
    let containerHasOwnShadow = true;

    const controller = await mountShadowUi(ctx, {
      name: "probe",
      css: ".a{}",
      onMount: (mount) => {
        shadowIsRoot = mount.shadow instanceof ShadowRoot;
        containerHasOwnShadow = mount.container.shadowRoot !== null;
      },
    });
    controller.mount();

    expect(shadowIsRoot).toBe(true);
    // The container already lives INSIDE WXT's shadow root. A stray
    // attachShadow() here does NOT throw in Chrome -- it silently creates a
    // nested root, which would hide WXT's `:host { all: initial }` reset and
    // any CSS it injects. So this must be false, and the failure mode is
    // silent rather than loud.
    expect(containerHasOwnShadow).toBe(false);
  });

  it("passes container, shadow and host to the caller's onMount", async () => {
    const received: { container: HTMLElement; shadow: ShadowRoot; host: HTMLElement }[] = [];

    const controller = await mountShadowUi(ctx, {
      name: "probe",
      css: ".a{}",
      onMount: (mount) => {
        received.push(mount);
      },
    });
    controller.mount();

    expect(received).toHaveLength(1);
    const mount = received[0];
    expect(mount?.shadow).toBeInstanceOf(ShadowRoot);
    expect(mount?.container).toBeInstanceOf(HTMLElement);
    expect(mount?.host.tagName.toLowerCase()).toBe("es-probe");
  });

  it("leaves the host completely unstyled, so it cannot affect page layout", async () => {
    const controller = await mountShadowUi(ctx, {
      name: "probe",
      css: ".a{}",
      onMount: () => undefined,
    });
    controller.mount();

    const host = controller.host;
    // No inline styles at all. Positioning and pointer-events belong to the
    // container, styled by the caller's own shadow CSS: WXT applies
    // `:host { all: initial !important }`, and `all` includes `position`, so any
    // host positioning we set is silently overridden (measured in Chrome).
    expect(host.getAttribute("style")).toBeNull();
    expect(host.style.position).toBe("");
  });

  it("can opt out of the fixed-position host treatment", async () => {
    const controller = await mountShadowUi(ctx, {
      name: "probe",
      css: ".a{}",
      onMount: () => undefined,
    });
    controller.mount();

    // Host styling is unconditional now: there is none.
    expect(controller.host.getAttribute("style")).toBeNull();
  });

  it("returns the caller's mount handle and forwards it to onRemove", async () => {
    const onRemove = vi.fn();

    const controller = await mountShadowUi(ctx, {
      name: "probe",
      css: ".a{}",
      onMount: () => ({ kind: "button" }),
      onRemove,
    });

    controller.mount();
    expect(controller.mounted).toEqual({ kind: "button" });

    const options = createShadowRootUi.mock.calls.at(-1)?.[1] as {
      onRemove: (m: unknown) => void;
    };
    expect(typeof options.onRemove).toBe("function");
    options.onRemove?.({ kind: "button" });
    expect(onRemove).toHaveBeenCalledWith({ kind: "button" });
  });

  it("omits onRemove entirely when not supplied (exactOptionalPropertyTypes)", async () => {
    await mountShadowUi(ctx, { name: "probe", css: ".a{}", onMount: () => undefined });
    const options = createShadowRootUi.mock.calls[0]?.[1] as Record<string, unknown>;
    expect("onRemove" in options).toBe(false);
  });

  // Regression: our stylesheet was silently dropped, so the micro-button rendered
  // unstyled (32x25 instead of 28x28) at the bottom of the page instead of next
  // to the selection. Nothing caught it until the real-browser check inspected
  // the shadow root and found only WXT's reset rule in the <style>.
  it("passes our stylesheet to WXT so it lands in the shadow root", async () => {
    await mountShadowUi(ctx, {
      name: "probe",
      css: ".es-root{position:fixed}.es-button{border-radius:50%}",
      onMount: () => undefined,
    });
    const options = createShadowRootUi.mock.calls[0]?.[1] as { css: string };
    expect(options.css).toContain(".es-root");
    expect(options.css).toContain(".es-button");
  });

  it("isolates styles from the page by resetting inherited styles", async () => {
    await mountShadowUi(ctx, { name: "probe", css: ".a{}", onMount: () => undefined });
    const options = createShadowRootUi.mock.calls[0]?.[1] as { inheritStyles: boolean };
    expect(options.inheritStyles).toBe(false);
  });
});

describe("styleSheet", () => {
  it("builds a <style> element from CSS text", () => {
    const style = styleSheet(".x{color:red}");
    expect(style.tagName).toBe("STYLE");
    expect(style.textContent).toBe(".x{color:red}");
  });
});