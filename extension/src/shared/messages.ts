/**
 * One typed message protocol for the whole extension (spec 5.10).
 *
 * Content script  <->  background (service worker)  <->  side panel
 *
 * Rules enforced here:
 *  - every message is a discriminated union member, so `switch` is exhaustive
 *    (see tsconfig `switch-exhaustiveness-check`);
 *  - no message may carry a `chrome.runtime.MessageSender` or a DOM node;
 *  - `PractiseTarget` is the single payload that carries selected text from the
 *    pop-up to the side panel, so text/accent/speed never need re-typing.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Supported accents. Two only, on purpose: everything downstream keys off this. */
export type Accent = "en-US" | "en-GB";

export const ACCENTS: readonly Accent[] = ["en-US", "en-GB"];

export type PracticeKind = "word" | "sentence";

/** Playback speeds offered in the pop-up (spec 4.2). The panel adds more. */
export const POPUP_SPEEDS = [0.5, 0.75, 1] as const;
export type PopupSpeed = (typeof POPUP_SPEEDS)[number];

/** How the practice session should be handed to the side panel. */
export interface PracticeTarget {
  /** Trimmed, whitespace-collapsed selection text. Never logged (spec 9). */
  readonly text: string;
  readonly kind: PracticeKind;
  readonly accent: Accent;
  readonly speed: number;
  /**
   * True when the selection exceeded the pop-up's comfortable length, so the
   * pop-up may offer "first sentence only" (spec 4.1).
   */
  readonly truncated?: boolean;
}

export interface DictionaryEntry {
  readonly partOfSpeech: string;
  /** Source-tagged transcriptions. `accent` is null when the source does not
   *  say which variety it is - we never invent a UK reading (spec 5.2). */
  readonly ipa: readonly { readonly accent: Accent | null; readonly text: string }[];
  readonly definitions: readonly string[];
  readonly example: string | null;
  readonly sourceUrl: string;
}

/** Why a dictionary lookup failed, in terms the UI can localise. */
export type DictionaryFailure =
  | "not-found"
  | "offline"
  | "rate-limited"
  | "server"
  | "bad-word";

export type DictionaryResult =
  | { readonly ok: true; readonly word: string; readonly entries: readonly DictionaryEntry[] }
  | { readonly ok: false; readonly word: string; readonly reason: DictionaryFailure };

// ---------------------------------------------------------------------------
// Messages: page -> background
// ---------------------------------------------------------------------------

export type ToBackground =
  | { readonly type: "content:ready" }
  | { readonly type: "selection:captured"; readonly target: PracticeTarget }
  | { readonly type: "selection:cleared" }
  | { readonly type: "open-panel"; readonly target: PracticeTarget | null }
  | {
      readonly type: "dictionary:lookup";
      readonly word: string;
      readonly requestId: string;
    }
  | {
      /**
       * Pronunciation from the bundled CMUdict (spec 5.2).
       *
       * The dictionary is 2.09 MB, so it is answered by the background rather
       * than loaded in every content script.
       */
      readonly type: "ipa:lookup";
      readonly word: string;
      readonly requestId: string;
    };

// ---------------------------------------------------------------------------
// Messages: background -> page
// ---------------------------------------------------------------------------

export type FromBackground =
  | { readonly type: "dict:result"; readonly requestId: string; readonly result: DictionaryResult }
  | { readonly type: "ipa:result"; readonly requestId: string; readonly result: IpaResult }
  | { readonly type: "panel:opened"; readonly ok: boolean }
  | { readonly type: "panel:begin-practice"; readonly target: PracticeTarget }
  | { readonly type: "panel:show-notice"; readonly messageKey: string }
  | { readonly type: "settings:changed" }
  /** Background asks the page to open the quick-read pop-up for its selection. */
  | {
      readonly type: "selection:request";
      readonly fallbackText?: string;
      /** `popup` for the shortcut; `practice` for a context-menu hand-off. */
      readonly intent?: "popup" | "practice";
    };

/** Reply to `ipa:lookup`. `ok: false` means "not in CMUdict", not an error. */
export interface IpaResult {
  readonly ok: boolean;
  readonly word: string;
  /** Present only when `ok`. Always `en-US`; CMUdict has no UK data (spec 5.2). */
  readonly ipa?: string;
  /** IPA per syllable, so the UI can highlight the stressed one (spec 4.2). */
  readonly syllables?: readonly { readonly ipa: string; readonly stress: 0 | 1 | 2 }[];
  /** Alternate readings, e.g. record -> REC-ord / re-CORD. */
  readonly variants?: readonly { readonly ipa: string }[];
}

// ---------------------------------------------------------------------------
// Messages: background <-> side panel
// ---------------------------------------------------------------------------

export type PanelRequest =
  /** Send the user straight into a practice session (context menu / shortcut). */
  | { readonly type: "panel:begin-practice"; readonly target: PracticeTarget }
  | { readonly type: "panel:get-target" };

export type PanelResponse =
  | { readonly type: "panel:target"; readonly target: PracticeTarget | null };

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export const ACCENT_LABELS: Record<Accent, string> = {
  "en-US": "US",
  "en-GB": "UK",
};

export function isAccent(value: unknown): value is Accent {
  return typeof value === "string" && (ACCENTS as readonly string[]).includes(value);
}

/**
 * Single words go through the "word" flow (meaning, one IPA, Listen).
 * Everything else is treated as a sentence.
 */
export function classifyText(text: string): PracticeKind {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "sentence";
  // A "word" here means a single token with no terminal punctuation, which is
  // what distinguishes a look-up target from a phrase to shadow.
  return /^[A-Za-zÀ-ɏ'’-]+$/.test(trimmed) ? "word" : "sentence";
}

/** Reject anything that is not a plausible dictionary lookup key. */
export function isLookupWord(value: string): boolean {
  return value.length > 0 && value.length <= 64 && /^[A-Za-zÀ-ɏ'’-]+$/.test(value);
}