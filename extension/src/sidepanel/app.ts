/**
 * Side-panel application shell.
 *
 * Owns the tab navigation (spec 3: ARIA tabs, roving tabindex), the shared host
 * passed to each tab, theme/language application, session hand-off from the
 * pop-up or context menu, and storage synchronisation while the panel is open.
 */

import { applyTranslations, loadMessages, makeTranslator, type Translate } from "../shared/i18n";
import {
  DEFAULT_SETTINGS,
  ROOT_KEY,
  readStore,
  takeSessionNotice,
  updateStore,
  type Settings,
} from "../shared/storage";
import type { PracticeTarget } from "../shared/messages";
import type { TabId, SettingsPatch } from "./host";
import { createPractiseTab, type PractiseTab } from "./practise";
import { createSavedTab, type SavedTab } from "./saved";
import { createSettingsTab, type SettingsTab } from "./settings";
import { createOnboarding } from "./onboarding";
import { el } from "./dom";

const TABS: readonly TabId[] = ["practise", "saved", "settings"];

function isTabId(value: string): value is TabId {
  return (TABS as readonly string[]).includes(value);
}

export async function mountApp(): Promise<void> {
  const initial = await readStore().catch(() => null);
  let settings: Settings = initial?.settings ?? DEFAULT_SETTINGS;
  const messages = await loadMessages(settings.uiLanguage);
  const t: Translate = makeTranslator(messages);

  document.title = t("extName");
  applyTranslations(document, t);
  applyTheme(settings);

  const panelPractise = document.getElementById("panel-practise");
  const panelSaved = document.getElementById("panel-saved");
  const panelSettings = document.getElementById("panel-settings");
  if (!panelPractise || !panelSaved || !panelSettings) return;

  // Clear the Phase 1 placeholders without using innerHTML.
  panelPractise.replaceChildren();
  panelSaved.replaceChildren();
  panelSettings.replaceChildren();

  const toastNode = el({
    tag: "div",
    class: "toast",
    attrs: { role: "status", "aria-live": "polite" },
  });
  document.body.appendChild(toastNode);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const toast = (message: string): void => {
    toastNode.textContent = message;
    toastNode.classList.add("visible");
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastNode.classList.remove("visible");
      toastTimer = null;
    }, 3_500);
  };

  // -------------------------------------------------------------------------
  // Tab navigation
  // -------------------------------------------------------------------------

  const tabButtons = TABS.map((id) => document.getElementById(`tab-${id}`));

  const select = (id: TabId, options: { focus?: boolean } = {}): void => {
    for (const [index, tab] of TABS.entries()) {
      const button = tabButtons[index];
      const panel = document.getElementById(`panel-${tab}`);
      const active = tab === id;
      button?.setAttribute("aria-selected", String(active));
      button?.setAttribute("tabindex", active ? "0" : "-1");
      if (panel) panel.hidden = !active;
    }
    if (options.focus) document.getElementById(`tab-${id}`)?.focus();
  };

  const move = (from: TabId, delta: number): void => {
    const current = TABS.indexOf(from);
    const next = TABS[(current + delta + TABS.length) % TABS.length];
    if (next) select(next, { focus: true });
  };

  for (const button of tabButtons) {
    button?.addEventListener("click", () => {
      const id = button.dataset["tab"];
      if (id && isTabId(id)) select(id);
    });

    button?.addEventListener("keydown", (event: KeyboardEvent) => {
      const id = button.dataset["tab"];
      if (!id || !isTabId(id)) return;

      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
          event.preventDefault();
          move(id, 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
          event.preventDefault();
          move(id, -1);
          break;
        case "Home":
          event.preventDefault();
          select(TABS[0] ?? "practise", { focus: true });
          break;
        case "End":
          event.preventDefault();
          select(TABS[TABS.length - 1] ?? "settings", { focus: true });
          break;
        default:
          break;
      }
    });
  }

  document.getElementById("tablist")?.addEventListener("focusin", (event) => {
    const id = (event.target as HTMLElement | null)?.dataset["tab"];
    if (id && isTabId(id)) select(id);
  });

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  let practise: PractiseTab | null = null;
  let saved: SavedTab | null = null;
  let settingsTab: SettingsTab | null = null;

  const host = {
    t,
    get settings() {
      return settings;
    },
    async updateSettings(patch: SettingsPatch): Promise<void> {
      const languageChanged =
        patch.uiLanguage !== undefined && patch.uiLanguage !== settings.uiLanguage;
      try {
        await updateStore((store) => ({
          store: { ...store, settings: { ...store.settings, ...patch } },
          result: null,
        }));
      } catch (error) {
        toast(t("errQuota"));
        throw error;
      }
      settings = (await readStore()).settings;
      applyTheme(settings);
      practise?.setSettings(settings);
      settingsTab?.refresh(settings);
      saved?.refresh();
      if (languageChanged) {
        // Each tab holds a translator snapshot; a reload is the honest way to
        // re-render every visible string in the new language.
        window.location.reload();
      }
    },
    toast,
    openTab(id: TabId) {
      select(id);
    },
    setTarget(target: PracticeTarget) {
      practise?.setTarget(target);
      select("practise");
      void updateStore((store) => ({
        store: { ...store, session: { ...store.session, target } },
        result: null,
      })).catch(() => undefined);
    },
  };

  practise = createPractiseTab(host);
  saved = createSavedTab(host);
  settingsTab = createSettingsTab(host);
  panelPractise.appendChild(practise.element);
  panelSaved.appendChild(saved.element);
  panelSettings.appendChild(settingsTab.element);

  // -------------------------------------------------------------------------
  // Session hand-off (pop-up, shortcut, context menu)
  // -------------------------------------------------------------------------

  const showTarget = (target: PracticeTarget | null): void => {
    if (!target) return;
    practise?.setTarget(target);
    select("practise");
  };

  showTarget(initial?.session.target ?? null);

  const showNotice = async (): Promise<void> => {
    const notice = await takeSessionNotice().catch(() => null);
    if (notice) toast(t(notice));
  };
  void showNotice();

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (typeof message !== "object" || message === null) return false;
    const type = (message as { type?: unknown }).type;
    if (type === "panel:begin-practice") {
      const target = (message as { target?: PracticeTarget }).target;
      if (target) showTarget(target);
      sendResponse({ ok: true });
      return false;
    }
    if (type === "panel:show-notice") {
      const key = (message as { messageKey?: unknown }).messageKey;
      if (typeof key === "string") toast(t(key));
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  let lastSettings = settings;
  let lastTarget = JSON.stringify(initial?.session.target ?? null);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(ROOT_KEY in changes)) return;
    void (async () => {
      const store = await readStore().catch(() => null);
      if (!store) return;

      if (store.settings.uiLanguage !== lastSettings.uiLanguage) {
        window.location.reload();
        return;
      }
      const settingsChanged = JSON.stringify(store.settings) !== JSON.stringify(lastSettings);
      lastSettings = store.settings;
      settings = store.settings;
      if (settingsChanged) {
        applyTheme(settings);
        practise?.setSettings(settings);
        settingsTab?.refresh(settings);
      }

      saved?.refresh();

      const targetKey = JSON.stringify(store.session.target);
      if (targetKey !== lastTarget) {
        lastTarget = targetKey;
        if (store.session.target) showTarget(store.session.target);
      }
      await showNotice();
    })().catch(() => undefined);
  });

  // -------------------------------------------------------------------------
  // Onboarding
  // -------------------------------------------------------------------------

  select("practise");

  if (!settings.onboardingCompleted) {
    createOnboarding(host).open();
  }
}

function applyTheme(settings: Settings): void {
  document.documentElement.dataset["theme"] = settings.theme;
}
