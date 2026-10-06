/**
 * Tests for the typed messaging wrappers (spec 5.10).
 *
 * The behaviour that actually matters here is error classification: when the
 * extension context is invalidated (user reloaded the page, or reloaded the
 * extension during development) the UI must degrade quietly, not throw an
 * unhandled rejection at the user.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextGoneError, sendToBackground } from "../src/shared/bus";
import type { FromBackground } from "../src/shared/messages";

const REPLY = {
  type: "dict:result",
  requestId: "r1",
  result: { ok: false, word: "schedule", reason: "offline" },
} satisfies FromBackground;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubSendMessage(impl: (message: unknown) => Promise<unknown>) {
  const sendMessage = vi.fn(impl);
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  return sendMessage;
}

describe("sendToBackground", () => {
  it("passes the reply through the type guard", async () => {
    stubSendMessage(() => Promise.resolve(REPLY));
    const reply = await sendToBackground(
      { type: "dictionary:lookup", word: "schedule", requestId: "r1" },
      (r) => r,
    );
    // Narrow on `type` first: this is exactly how call sites will consume it.
    expect(reply?.type).toBe("dict:result");
    if (reply?.type !== "dict:result") throw new Error("expected a dict:result reply");
    expect(reply.result.ok).toBe(false);
  });

  it("returns null when nothing is listening", async () => {
    stubSendMessage(async () => undefined);
    expect(
      await sendToBackground({ type: "content:ready" }, (r) => r),
    ).toBeNull();
  });

  it("returns null when the reply is null", async () => {
    stubSendMessage(async () => null);
    expect(
      await sendToBackground({ type: "content:ready" }, (r) => r),
    ).toBeNull();
  });

  it("raises ContextGoneError when the context was invalidated", async () => {
    stubSendMessage(async () => {
      throw new Error(
        "Could not establish connection. Receiving end does not exist.",
      );
    });
    await expect(
      sendToBackground({ type: "content:ready" }, (r) => r),
    ).rejects.toBeInstanceOf(ContextGoneError);
  });

  it("raises ContextGoneError when the message port closes", async () => {
    stubSendMessage(async () => {
      throw new Error("message port closed before a response was received");
    });
    await expect(
      sendToBackground({ type: "content:ready" }, (r) => r),
    ).rejects.toBeInstanceOf(ContextGoneError);
  });

  it("swallows other failures, returning null", async () => {
    stubSendMessage(async () => {
      throw new Error("something unexpected");
    });
    expect(
      await sendToBackground({ type: "content:ready" }, (r) => r),
    ).toBeNull();
  });

  it("sends exactly the message it was given", async () => {
    const sendMessage = stubSendMessage(async () => REPLY);
    const target = {
      type: "open-panel",
      target: { text: "record", kind: "word", accent: "en-GB", speed: 0.75 },
    } as const;

    await sendToBackground(target, (r) => r);
    expect(sendMessage).toHaveBeenCalledWith(target);
  });
});