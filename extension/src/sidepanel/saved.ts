/**
 * Saved tab (spec 4.3, Phase 10).
 *
 * The list, search, review cards, export/import and clear-all. All storage
 * mutation goes through `shared/saved.ts`, which owns quota handling and import
 * validation; this module only renders results and reports them.
 */

import { clear, el } from "./dom";
import type { PanelHost } from "./host";
import { requestDictionary } from "../shared/requests";
import { ACCENT_LABELS, type DictionaryEntry } from "../shared/messages";
import {
  clearSaved,
  filterSaved,
  importSaved,
  listSaved,
  removeSaved,
  serialiseSaved,
  setBox,
} from "../shared/saved";
import { Speaker, browserSpeechSource } from "../services/tts";
import type { SavedItem } from "../shared/storage";
import { makeSvgPlayIcon, makeSvgRepeatIcon } from "../ui/icons";

export interface SavedTab {
  readonly element: HTMLElement;
  refresh(): void;
  destroy(): void;
}

interface ReviewState {
  /** Ids in review order, fixed when review starts so box moves do not reshuffle. */
  readonly order: readonly string[];
  index: number;
  flipped: boolean;
}

export function createSavedTab(host: PanelHost): SavedTab {
  const t = host.t;
  let items: readonly SavedItem[] = [];
  let query = "";
  let review: ReviewState | null = null;
  let reviewMeaning: DictionaryEntry | null = null;
  let reviewMeaningState: "idle" | "loading" | "ready" = "idle";
  let loading = true;
  let speaker: Speaker | null = null;
  let destroyed = false;

  const root = el({ tag: "section", class: "saved" });

  const search = el({
    tag: "input",
    class: "search",
    attrs: {
      type: "search",
      id: "saved-search",
      placeholder: t("savedSearchPlaceholder"),
      "aria-label": t("savedSearchPlaceholder"),
    },
  }) as HTMLInputElement;
  search.addEventListener("input", () => {
    query = search.value;
    renderList();
  });

  const reviewButton = el({
    tag: "button",
    class: "button",
    children: [makeSvgRepeatIcon(), ` ${t("savedReview")}`],
    attrs: { type: "button" },
  }) as HTMLButtonElement;

  const exportButton = el({
    tag: "button",
    class: "button",
    text: t("btnExport"),
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  const importButton = el({
    tag: "button",
    class: "button",
    text: t("btnImport"),
    attrs: { type: "button" },
  }) as HTMLButtonElement;
  const clearButton = el({
    tag: "button",
    class: "button danger",
    text: t("btnClearAll"),
    attrs: { type: "button" },
  }) as HTMLButtonElement;

  const fileInput = el({
    tag: "input",
    attrs: { type: "file", accept: "application/json,.json", hidden: true },
  }) as HTMLInputElement;

  const toolbar = el({ tag: "div", class: "button-row wrap" });
  toolbar.append(reviewButton, exportButton, importButton, clearButton);

  const countLine = el({ tag: "p", class: "hint", attrs: { role: "status" } });
  const list = el({ tag: "div", class: "saved-list" });

  root.append(search, toolbar, fileInput, countLine, list);

  // -------------------------------------------------------------------------
  // Main list
  // -------------------------------------------------------------------------

  const language = (): string => (host.settings.uiLanguage === "fr" ? "fr-FR" : "en-GB");

  const dateLabel = (createdAt: number): string =>
    t(
      "savedDate",
      new Intl.DateTimeFormat(language(), { dateStyle: "medium" }).format(
        new Date(createdAt),
      ),
    );

  const ensureSpeaker = (): Speaker | null => {
    if (speaker) return speaker;
    const source = browserSpeechSource();
    if (!source) {
      host.toast(t("errTtsUnavailable"));
      return null;
    }
    speaker = new Speaker({ source });
    return speaker;
  };

  const speakItem = (item: SavedItem): void => {
    const engine = ensureSpeaker();
    if (!engine) return;
    void engine.speak(item.text, {
      accent: item.accent,
      voiceName: item.accent === "en-GB" ? host.settings.voiceUk : host.settings.voiceUs,
      onError: () => host.toast(t("errTtsUnavailable")),
    });
  };

  const itemCard = (item: SavedItem): HTMLElement => {
    const card = el({ tag: "article", class: "saved-card" });
    card.appendChild(el({ tag: "p", class: "saved-text", text: item.text }));
    if (item.ipa !== "") {
      card.appendChild(el({ tag: "p", class: "saved-ipa", text: item.ipa }));
    }

    const meta = el({ tag: "p", class: "hint" });
    meta.textContent = [
      `${ACCENT_LABELS[item.accent]} · ${dateLabel(item.createdAt)}`,
      t("savedAttempts", item.attempts),
      t("savedBox", item.box),
      item.lastResult
        ? t("wordsRecognised", item.lastResult.recognised, item.lastResult.total)
        : t("savedNoResult"),
    ].join(" · ");
    card.appendChild(meta);

    const row = el({ tag: "div", class: "button-row" });
    const listen = el({
      tag: "button",
      class: "button small",
      children: [makeSvgPlayIcon(), ` ${t("btnListen")}`],
      attrs: { type: "button" },
    }) as HTMLButtonElement;
    listen.addEventListener("click", () => speakItem(item));

    const remove = el({
      tag: "button",
      class: "button small danger",
      text: t("btnDelete"),
      attrs: { type: "button" },
    }) as HTMLButtonElement;
    remove.addEventListener("click", () => {
      if (!window.confirm(t("savedDeleteConfirm"))) return;
      void removeSaved(item.id)
        .then(() => {
          host.toast(t("savedDeleted"));
          return refresh();
        })
        .catch(() => host.toast(t("errQuota")));
    });

    row.append(listen, remove);
    card.appendChild(row);
    return card;
  };

  const startReview = (): void => {
    if (items.length === 0) {
      host.toast(t("savedEmpty"));
      return;
    }
    const order = [...items]
      .sort((a, b) => a.box - b.box || a.createdAt - b.createdAt)
      .map((item) => item.id);
    review = { order, index: 0, flipped: false };
    reviewMeaning = null;
    reviewMeaningState = "idle";
    render();
  };

  const finishReview = (): void => {
    review = null;
    reviewMeaning = null;
    render();
  };

  // -------------------------------------------------------------------------
  // Review card
  // -------------------------------------------------------------------------

  const loadMeaning = async (item: SavedItem): Promise<void> => {
    reviewMeaningState = "loading";
    reviewMeaning = null;
    renderReview();
    if (item.kind !== "word") {
      reviewMeaningState = "ready";
      renderReview();
      return;
    }
    const result = await requestDictionary(item.text);
    if (destroyed) return;
    reviewMeaning = result?.ok ? (result.entries[0] ?? null) : null;
    reviewMeaningState = "ready";
    renderReview();
  };

  const advanceReview = async (item: SavedItem, good: boolean | null): Promise<void> => {
    if (good !== null) {
      await setBox(item.id, good ? Math.min(5, item.box + 1) : 1).catch(() =>
        host.toast(t("errQuota")),
      );
    }
    if (!review) return;
    if (review.index + 1 >= review.order.length) {
      finishReview();
      return;
    }
    review = { ...review, index: review.index + 1, flipped: false };
    reviewMeaning = null;
    reviewMeaningState = "idle";
    await refresh();
  };

  const renderReview = (): void => {
    clear(list);
    const state = review;
    if (!state) return;
    const item = items.find((candidate) => candidate.id === state.order[state.index]);
    if (!item) {
      finishReview();
      return;
    }

    const card = el({ tag: "article", class: "review-card" });
    card.appendChild(
      el({
        tag: "p",
        class: "hint",
        text: `${state.index + 1} / ${state.order.length} · ${t("savedBox", item.box)}`,
      }),
    );
    card.appendChild(el({ tag: "p", class: "review-text", text: item.text }));
    if (item.ipa !== "") {
      card.appendChild(el({ tag: "p", class: "saved-ipa", text: item.ipa }));
    }

    if (!state.flipped) {
      const listen = el({
        tag: "button",
        class: "button",
        children: [makeSvgPlayIcon(), ` ${t("btnListen")}`],
        attrs: { type: "button" },
      }) as HTMLButtonElement;
      listen.addEventListener("click", () => speakItem(item));
      const flip = el({
        tag: "button",
        class: "button primary",
        text: t("btnFlip"),
        attrs: { type: "button" },
      }) as HTMLButtonElement;
      flip.addEventListener("click", () => {
        if (!review) return;
        review = { ...review, flipped: true };
        void loadMeaning(item);
        renderReview();
      });
      const row = el({ tag: "div", class: "button-row" });
      row.append(listen, flip);
      card.appendChild(row);
    } else {
      if (reviewMeaningState === "loading") {
        card.appendChild(el({ tag: "p", class: "hint", text: t("savedLoadingMeaning") }));
      } else if (reviewMeaning) {
        card.appendChild(
          el({ tag: "p", class: "saved-pos", text: reviewMeaning.partOfSpeech }),
        );
        const definitions = el({ tag: "ol", class: "saved-defs" });
        for (const definition of reviewMeaning.definitions.slice(0, 2)) {
          definitions.appendChild(el({ tag: "li", text: definition }));
        }
        card.appendChild(definitions);
      } else {
        card.appendChild(
          el({
            tag: "p",
            class: "hint",
            text: item.kind === "word" ? t("popupNoDefinitions") : t("savedMeaningUnavailable"),
          }),
        );
      }

      const again = el({
        tag: "button",
        class: "button",
        text: t("btnAgain"),
        attrs: { type: "button" },
      }) as HTMLButtonElement;
      again.addEventListener("click", () => void advanceReview(item, false));      const good = el({
        tag: "button",
        class: "button primary",
        text: t("btnGood"),
        attrs: { type: "button" },
      }) as HTMLButtonElement;
      good.addEventListener("click", () => void advanceReview(item, true));
      const skip = el({
        tag: "button",
        class: "link-button",
        text: t("btnSkip"),
        attrs: { type: "button" },
      }) as HTMLButtonElement;
      skip.addEventListener("click", () => void advanceReview(item, null));
      const row = el({ tag: "div", class: "button-row" });
      row.append(again, good, skip);
      card.appendChild(row);
    }

    const exit = el({
      tag: "button",
      class: "link-button",
      text: t("btnDone"),
      attrs: { type: "button" },
    }) as HTMLButtonElement;
    exit.addEventListener("click", finishReview);
    card.appendChild(exit);
    list.appendChild(card);
  };

  // -------------------------------------------------------------------------
  // Export / import / clear
  // -------------------------------------------------------------------------

  exportButton.addEventListener("click", () => {
    if (items.length === 0) {
      host.toast(t("savedEmpty"));
      return;
    }
    const blob = new Blob([serialiseSaved(items)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = el({
      tag: "a",
      attrs: { href: url, download: `english-shadowing-${new Date().toISOString().slice(0, 10)}.json` },
    });
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5_000);
    host.toast(t("savedExported"));
  });

  importButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    void file
      .text()
      .then(async (json) => {
        const result = await importSaved(json);
        if (!result.ok) {
          host.toast(
            result.reason === "invalid"
              ? t("savedImportInvalid")
              : result.reason === "empty"
                ? t("savedImportEmpty")
                : result.reason === "too-many"
                  ? t("savedImportTooMany")
                  : t("errQuota"),
          );
          return;
        }
        host.toast(t("savedImportDone", result.added));
        await refresh();
      })
      .catch(() => host.toast(t("savedImportInvalid")))
      .finally(() => {
        fileInput.value = "";
      });
  });

  clearButton.addEventListener("click", () => {
    if (!window.confirm(t("savedClearConfirm"))) return;
    void clearSaved()
      .then(() => {
        host.toast(t("savedDeleted"));
        return refresh();
      })
      .catch(() => host.toast(t("errQuota")));
  });

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const renderList = (): void => {
    if (review) {
      renderReview();
      return;
    }
    clear(list);
    if (loading) {
      list.appendChild(el({ tag: "p", class: "hint", text: t("loadingIpa") }));
      return;
    }
    const filtered = filterSaved(items, query);
    countLine.textContent = t("savedCount", filtered.length);
    if (filtered.length === 0) {
      list.appendChild(
        el({ tag: "p", class: "empty-state", text: items.length === 0 ? t("savedEmpty") : t("popupNoDefinitions") }),
      );
      return;
    }
    for (const item of filtered) list.appendChild(itemCard(item));
  };

  const render = (): void => {
    reviewButton.replaceChildren(makeSvgRepeatIcon(), ` ${t("savedReview")}`);
    reviewButton.disabled = items.length === 0;
    exportButton.disabled = items.length === 0;
    clearButton.disabled = items.length === 0;
    renderList();
  };

  const refresh = async (): Promise<void> => {
    try {
      items = await listSaved();
    } catch {
      items = [];
    }
    loading = false;
    if (review) {
      const remaining = review.order.filter((id) => items.some((item) => item.id === id));
      if (remaining.length === 0) review = null;
      else if (review.index >= remaining.length) {
        review = { ...review, order: remaining, index: remaining.length - 1, flipped: false };
      }
    }
    render();
  };

  reviewButton.addEventListener("click", startReview);

  void refresh();

  return {
    element: root,
    refresh: () => void refresh(),
    destroy() {
      destroyed = true;
      speaker?.stop();
    },
  };
}
