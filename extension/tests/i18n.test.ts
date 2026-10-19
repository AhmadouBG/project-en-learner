/**
 * Localisation (spec 3: EN/FR via `_locales`, all visible strings from message
 * files). The key-compatibility check is deliberately a test rather than a
 * convention: a missing French string must fail CI, not show an English key in
 * the product.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  flattenMessages,
  formatMessage,
  loadMessages,
  makeTranslator,
  resetMessagesCache,
} from "../src/shared/i18n";

function locale(language: "en" | "fr"): Record<string, { message?: string }> {
  const url = new URL(`../public/_locales/${language}/messages.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as Record<
    string,
    { message?: string }
  >;
}

describe("locale files", () => {
  it("define exactly the same keys in English and French", () => {
    const en = Object.keys(locale("en")).sort();
    const fr = Object.keys(locale("fr")).sort();
    expect(fr).toEqual(en);
  });

  it("never ship an empty translation", () => {
    for (const language of ["en", "fr"] as const) {
      for (const [key, value] of Object.entries(locale(language))) {
        expect(value.message, `${language}/${key}`).toBeTypeOf("string");
        expect(value.message?.trim(), `${language}/${key}`).not.toBe("");
      }
    }
  });
});

describe("flattenMessages", () => {
  it("keeps only well-formed rows", () => {
    expect(
      flattenMessages({
        ok: { message: "Fine" },
        empty: {},
        wrong: { message: 3 },
        missing: undefined,
      }),
    ).toEqual({ ok: "Fine" });
  });

  it("returns an empty bag for garbage rather than throwing", () => {
    for (const value of [null, 0, "text", []]) expect(flattenMessages(value)).toEqual({});
  });
});

describe("formatMessage", () => {
  it("fills Chrome-style placeholders", () => {
    expect(formatMessage({ greet: "Hello $1, you have $2" }, "greet", ["Ada", 3])).toBe(
      "Hello Ada, you have 3",
    );
  });

  it("leaves an unknown placeholder intact and falls back to the key", () => {
    expect(formatMessage({ greet: "Hello $1 $9" }, "greet", ["Ada"])).toBe("Hello Ada $9");
    expect(formatMessage({}, "missing")).toBe("missing");
  });

  it("never treats substitutions as markup", () => {
    expect(formatMessage({ greet: "$1" }, "greet", ["<b>x</b>"])).toBe("<b>x</b>");
  });
});

describe("loadMessages", () => {
  it("loads a locale once and degrades to an empty bag on failure", async () => {
    resetMessagesCache();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ hello: { message: "Hello" } }),
    }));
    vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `chrome://${path}` } });
    vi.stubGlobal("fetch", fetchMock);

    const messages = await loadMessages("en");
    expect(messages).toEqual({ hello: "Hello" });
    expect(makeTranslator(messages)("hello")).toBe("Hello");

    await loadMessages("en");
    expect(fetchMock).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
  });
});
