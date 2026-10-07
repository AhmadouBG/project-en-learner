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

  it("keeps the host out of page layout so we cannot shift content", async () => {
    const controller = await mountShadowUi(ctx, {
      name: "probe",
      css: ".a{}",
      onMount: () => undefined,
    });
    controller.mount();

    const host = controller.host;
    // Order matters: `all: initial` resets everything, so it must be applied
    // FIRST. This was a real bug -- the original version set `all: initial`
    // last, which silently reset `position` back to static. happy-dom does not
    // cascade `all`, so only a real browser catches it; the unit test pins the
    // declared order so it cannot come back.
    expect(host.getAttribute("style")).not.toBeNull();
    const declarations = (host.getAttribute("style") ?? "")
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean);
    expect(declarations[0]?.startsWith("all")).toBe(true);

    expect(host.style.getPropertyPriority("position")).toBe("important");
    expect(host.style.getPropertyValue("position")).toBe("fixed");
    expect(host.style.getPropertyPriority("z-index")).toBe("important");
    expect(host.style.getPropertyValue("z-index")).toBe("2147483647");
    // happy-dom normalises the unit, so match either form.
    expect(host.style.getPropertyValue("width")).toMatch(/^0(px)?$/);
    expect(host.style.getPropertyValue("height")).toMatch(/^0(px)?$/);
    // The host must never swallow clicks meant for the page.
    expect(host.style.getPropertyValue("pointer-events")).toBe("none");
  });

  it("re-enables pointer events on the container so the UI is clickable", async () => {
    const controller = await mountShadowUi(ctx, {
      name: "probe",
      css: ".a{}",
      onMount: () => undefined,
    });
    controller.mount();

    expect(controller.container.style.getPropertyValue("pointer-events")).toBe("auto");
    expect(controller.container.style.getPropertyPriority("pointer-events")).toBe("important");
  });

  it("can opt out of the fixed-position host treatment", async () => {
    const controller = await mountShadowUi(ctx, {
      name: "probe",
      css: ".a{}",
      positionFixed: false,
      onMount: () => undefined,
    });
    controller.mount();

    expect(controller.host.style.getPropertyValue("position")).toBe("");
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