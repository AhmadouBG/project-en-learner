/**
 * Settings tab (spec 4.3, Phase 11).
 *
 * Every control writes through the host, which persists the settings and tells
 * the other tabs. A language change reloads the panel so every string is
 * translated again (the tabs hold a translator snapshot for their lifetime).
 */

import { clear, el, field } from "./dom";
import type { PanelHost, SettingsPatch } from "./host";
import { ACCENT_LABELS, type Accent } from "../shared/messages";
import {
  clearDictCache,
  type Settings,
  type ThemeChoice,
  type UiLanguage,
} from "../shared/storage";
import { SPEEDS, Speaker, browserSpeechSource, voicesForAccent, type VoiceLike } from "../services/tts";

export interface SettingsTab {
  readonly element: HTMLElement;
  refresh(settings: Settings): void;
  destroy(): void;
}

function select(
  id: string,
  label: string,
  options: readonly { readonly value: string; readonly label: string }[],
): HTMLSelectElement {
  const control = el({
    tag: "select",
    attrs: { id, "aria-label": label },
  }) as HTMLSelectElement;
  for (const option of options) {
    control.appendChild(
      el({ tag: "option", text: option.label, attrs: { value: option.value } }),
    );
  }
  return control;
}

export function createSettingsTab(host: PanelHost): SettingsTab {
  const t = host.t;
  let current: Settings = host.settings;
  let voices: readonly VoiceLike[] = browserSpeechSource()?.synth.getVoices() ?? [];

  const root = el({ tag: "section", class: "settings" });
  const saveSettings = async (patch: SettingsPatch): Promise<void> => {
    try {
      await host.updateSettings(patch);
      host.toast(t("settingsSaved"));
    } catch {
      host.toast(t("errQuota"));
    }
  };

  const accent = select("set-accent", t("defaultAccent"), [
    { value: "en-US", label: `${ACCENT_LABELS["en-US"]} — ${t("accentLongUS")}` },
    { value: "en-GB", label: `${ACCENT_LABELS["en-GB"]} — ${t("accentLongUK")}` },
  ]);
  accent.addEventListener("change", () => {
    const value: Accent = accent.value === "en-GB" ? "en-GB" : "en-US";
    void saveSettings({ defaultAccent: value });
  });

  const speed = select(
    "set-speed",
    t("defaultSpeed"),
    SPEEDS.map((value) => ({ value: String(value), label: `${value}×` })),
  );
  speed.addEventListener("change", () => {
    void saveSettings({ defaultSpeed: Number(speed.value) });
  });

  const voiceUs = select("set-voice-us", t("voiceUs"), [{ value: "", label: t("voiceAuto") }]);
  const voiceUk = select("set-voice-uk", t("voiceUk"), [{ value: "", label: t("voiceAuto") }]);
  voiceUs.addEventListener("change", () => {
    void saveSettings({ voiceUs: voiceUs.value === "" ? null : voiceUs.value });
  });
  voiceUk.addEventListener("change", () => {
    void saveSettings({ voiceUk: voiceUk.value === "" ? null : voiceUk.value });
  });

  const fillVoices = (): void => {
    for (const [control, language, saved] of [
      [voiceUs, "en-US", current.voiceUs],
      [voiceUk, "en-GB", current.voiceUk],
    ] as const) {
      clear(control);
      control.appendChild(el({ tag: "option", text: t("voiceAuto"), attrs: { value: "" } }));
      for (const voice of voicesForAccent(voices, language)) {
        control.appendChild(
          el({ tag: "option", text: voice.name, attrs: { value: voice.name } }),
        );
      }
      control.value = saved !== null && voices.some((voice) => voice.name === saved) ? saved : "";
    }
  };

  // Voices load asynchronously in Chrome; repopulate when they arrive.
  const speaker = (() => {
    const source = browserSpeechSource();
    return source ? new Speaker({ source }) : null;
  })();
  const stopVoices = speaker?.onVoicesChanged(() => {
    voices = speaker.getVoices();
    fillVoices();
  });

  const language = select("set-language", t("uiLanguage"), [
    { value: "en", label: t("languageEnglish") },
    { value: "fr", label: t("languageFrench") },
  ]);
  language.addEventListener("change", () => {
    const value: UiLanguage = language.value === "fr" ? "fr" : "en";
    void saveSettings({ uiLanguage: value });
  });

  const theme = select("set-theme", t("theme"), [
    { value: "system", label: t("themeSystem") },
    { value: "light", label: t("themeLight") },
    { value: "dark", label: t("themeDark") },
  ]);
  theme.addEventListener("change", () => {
    const value: ThemeChoice =
      theme.value === "light" || theme.value === "dark" ? theme.value : "system";
    void saveSettings({ theme: value });
  });

type BoolSettingKey =
  | "showButtonOnSelection"
  | "openPracticeAutomatically"
  | "autoSaveAfterFirstRecording"
  | "checkWordsAfterRecording"
  | "storeSourcePage";

  const checkbox = (
    id: string,
    label: string,
    key: BoolSettingKey,
  ): HTMLInputElement => {
    const input = el({
      tag: "input",
      attrs: { type: "checkbox", id },
    }) as HTMLInputElement;
    input.addEventListener("change", () => {
      const patch: SettingsPatch = {};
      patch[key] = input.checked;
      void saveSettings(patch);
    });
    const row = el({ tag: "label", class: "check-row", attrs: { for: id } });
    row.append(input, el({ tag: "span", text: label }));
    root.appendChild(row);
    return input;
  };

  const showButton = checkbox(
    "set-show-button",
    t("showButtonOnSelection"),
    "showButtonOnSelection",
  );
  const openAuto = checkbox(
    "set-open-auto",
    t("openPracticeAutomatically"),
    "openPracticeAutomatically",
  );
  const autoSave = checkbox(
    "set-autosave",
    t("autoSaveAfterFirstRecording"),
    "autoSaveAfterFirstRecording",
  );
  const checkWords = checkbox(
    "set-check-words",
    t("checkWordsAfterRecording"),
    "checkWordsAfterRecording",
  );
  const sourcePage = checkbox("set-source-page", t("storeSourcePage"), "storeSourcePage");

  const shortcutLink = el({
    tag: "button",
    class: "link-button",
    text: t("shortcutLink"),
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  shortcutLink.addEventListener("click", () => {
    void chrome.tabs
      .create({ url: "chrome://extensions/shortcuts" })
      .catch(() => host.toast(t("errOpenPanelFailed")));
  });

  const clearCacheButton = el({
    tag: "button",
    class: "button",
    text: t("clearCache"),
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  clearCacheButton.addEventListener("click", () => {
    if (!window.confirm(t("clearCacheConfirm"))) return;
    void clearDictCache()
      .then(() => host.toast(t("clearCacheDone")))
      .catch(() => host.toast(t("errQuota")));
  });

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  const general = el({ tag: "section", class: "card" });
  general.appendChild(el({ tag: "h2", class: "section-title", text: t("settingsTitle") }));
  general.append(
    field(t("defaultAccent"), accent),
    field(t("defaultSpeed"), speed),
    field(t("uiLanguage"), language),
    field(t("theme"), theme),
  );

  const voicesCard = el({ tag: "section", class: "card" });
  voicesCard.appendChild(el({ tag: "h2", class: "section-title", text: t("voiceUs") }));
  voicesCard.append(
    field(t("voiceUs"), voiceUs),
    field(t("voiceUk"), voiceUk),
    el({ tag: "p", class: "hint", text: t("voiceOsNote") }),
  );

  const behaviour = el({ tag: "section", class: "card" });
  behaviour.appendChild(
    el({ tag: "h2", class: "section-title", text: t("showButtonOnSelection") }),
  );

  const shortcutCard = el({ tag: "section", class: "card" });
  shortcutCard.appendChild(el({ tag: "h2", class: "section-title", text: t("shortcutHint") }));
  const shortcutRow = el({ tag: "div", class: "button-row" });
  shortcutRow.append(el({ tag: "kbd", text: "Alt+Shift+S" }), shortcutLink);
  shortcutCard.appendChild(shortcutRow);

  const privacy = el({ tag: "section", class: "card" });
  privacy.appendChild(el({ tag: "h2", class: "section-title", text: t("privacyTitle") }));
  privacy.appendChild(el({ tag: "p", class: "hint", text: t("privacyBody") }));
  privacy.appendChild(clearCacheButton);

  const credits = el({ tag: "section", class: "card" });
  credits.appendChild(el({ tag: "h2", class: "section-title", text: t("creditsTitle") }));
  credits.appendChild(el({ tag: "p", class: "hint", text: t("creditsBody") }));

  // Behaviour checkboxes are appended by `checkbox()`; move them into the card
  // in a deterministic order rather than leaving them at the bottom of the root.
  for (const input of [showButton, openAuto, autoSave, checkWords, sourcePage]) {
    const row = input.closest(".check-row");
    if (row) behaviour.appendChild(row);
  }

  root.append(general, voicesCard, behaviour, shortcutCard, privacy, credits);

  const refresh = (settings: Settings): void => {
    current = settings;
    accent.value = settings.defaultAccent;
    speed.value = String(settings.defaultSpeed);
    language.value = settings.uiLanguage;
    theme.value = settings.theme;
    showButton.checked = settings.showButtonOnSelection;
    openAuto.checked = settings.openPracticeAutomatically;
    autoSave.checked = settings.autoSaveAfterFirstRecording;
    checkWords.checked = settings.checkWordsAfterRecording;
    sourcePage.checked = settings.storeSourcePage;
    fillVoices();
  };

  refresh(current);

  return {
    element: root,
    refresh,
    destroy() {
      stopVoices?.();
      speaker?.stop();
    },
  };
}
