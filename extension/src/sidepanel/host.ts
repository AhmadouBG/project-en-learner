/**
 * Shared surface the side-panel tabs are given by `app.ts`.
 *
 * Keeping this narrow means the tabs do not import the app (no cycles) and the
 * current settings are always read through the host, so a change in Settings
 * reaches the practise tab without a reload.
 */

import type { Translate } from "../shared/i18n";
import type { PracticeTarget } from "../shared/messages";
import type { Settings } from "../shared/storage";

export type TabId = "practise" | "saved" | "settings";

/** A writable patch; `Settings` itself is readonly. */
export type SettingsPatch = {
  -readonly [K in keyof Settings]?: Settings[K];
};

export interface PanelHost {
  readonly t: Translate;
  readonly settings: Settings;
  /** Merge a settings patch, persist it, and notify every tab. */
  updateSettings(patch: SettingsPatch): Promise<void>;
  /** Show a short status message at the bottom of the panel. */
  toast(message: string): void;
  /** Switch the visible tab (e.g. "Practise" from an empty Saved state). */
  openTab(id: TabId): void;
  /** Hand a new target to the practise tab, as the pop-up does. */
  setTarget(target: PracticeTarget): void;
}
