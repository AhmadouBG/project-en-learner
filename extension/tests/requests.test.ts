/**
 * Tests for `requestMessages` (spec 3, 5.10).
 *
 * Content scripts run on the page's origin and therefore cannot fetch
 * `chrome-extension://…/_locales/…`: the request is cross-origin and rejected.
 * When that happened silently, every label in the micro-button and quick-read
 * pop-up rendered as its raw message key (`btnListen`, `popupSentenceIpa`) for
 * every user. The bag now comes from the background, so the reply handling is
 * worth a test: a stale or wrong-typed reply must be ignored rather than applied.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { requestMessages } from "../src/shared/requests";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubSendMessage(impl: (message: unknown) => Promise<unknown>) {
  const sendMessage = vi.fn(impl);
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  return sendMessage;
}

describe("requestMessages", () => {
  it("returns the bag when the background echoes the request id", async () => {
    const sendMessage = stubSendMessage(async (message) => ({
      type: "i18n:result",
      requestId: (message as { requestId: string }).requestId,
      messages: { btnListen: "Écouter", popupSpeed: "Vitesse" },
    }));

    const messages = await requestMessages("fr");

    expect(messages).toEqual({ btnListen: "Écouter", popupSpeed: "Vitesse" });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "i18n:messages",
      language: "fr",
      requestId: expect.any(String),
    });
  });

  it("ignores a reply meant for an earlier request", async () => {
    stubSendMessage(async () => ({
      type: "i18n:result",
      requestId: "r-does-not-match",
      messages: { btnListen: "Listen" },
    }));

    expect(await requestMessages("en")).toBeNull();
  });

  it("ignores a reply of the wrong shape", async () => {
    stubSendMessage(async () => ({
      type: "dict:result",
      requestId: "r1",
      result: { ok: false, word: "schedule", reason: "offline" },
    }));

    expect(await requestMessages("en")).toBeNull();
  });

  it("returns null when the background is gone, so callers can fall back", async () => {
    stubSendMessage(async () => undefined);

    expect(await requestMessages("en")).toBeNull();
  });
});
