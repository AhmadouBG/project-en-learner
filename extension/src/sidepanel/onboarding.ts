/**
 * First-run onboarding (spec 4.4): three skippable screens.
 *
 * It never asks for the microphone itself; mic permission is requested when the
 * user first presses Record, with the explanation already on the Practise tab.
 */

import { clear, el } from "./dom";
import type { PanelHost } from "./host";

export interface Onboarding {
  open(): void;
}

export function createOnboarding(host: PanelHost): Onboarding {
  const t = host.t;
  let step = 0;

  const dialog = el({
    tag: "dialog",
    class: "onboarding",
    attrs: { "aria-modal": "true" },
  }) as HTMLDialogElement;
  const body = el({ tag: "div", class: "onboarding-body" });
  dialog.appendChild(body);

  const finish = (): void => {
    dialog.close();
    void host.updateSettings({ onboardingCompleted: true }).catch(() => undefined);
  };

  const render = (): void => {
    clear(body);
    const number = step + 1;
    body.appendChild(
      el({ tag: "p", class: "hint", text: `${number} / 3` }),
    );
    body.appendChild(
      el({ tag: "h2", class: "onboarding-title", text: t(`onboardTitle${number}`) }),
    );
    body.appendChild(
      el({ tag: "p", class: "onboarding-text", text: t(`onboardBody${number}`) }),
    );

    const row = el({ tag: "div", class: "button-row" });
    const skip = el({
      tag: "button",
      class: "link-button",
      text: t("btnSkip"),
      attrs: { type: "button" },
    }) as HTMLButtonElement;
    skip.addEventListener("click", finish);

    const back = el({
      tag: "button",
      class: "button",
      text: t("btnBack"),
      attrs: { type: "button" },
    }) as HTMLButtonElement;
    back.hidden = step === 0;
    back.addEventListener("click", () => {
      step = Math.max(0, step - 1);
      render();
    });

    const next = el({
      tag: "button",
      class: "button primary",
      text: step === 2 ? t("btnDone") : t("btnNext"),
      attrs: { type: "button" },
    }) as HTMLButtonElement;
    next.addEventListener("click", () => {
      if (step === 2) {
        finish();
        return;
      }
      step += 1;
      render();
    });

    row.append(skip, back, next);
    body.appendChild(row);
    next.focus();
  };

  dialog.addEventListener("cancel", (event) => {
    // Esc skips rather than leaving the dialog in a half-open state.
    event.preventDefault();
    finish();
  });

  document.body.appendChild(dialog);

  return {
    open() {
      step = 0;
      render();
      if (!dialog.open) dialog.showModal();
    },
  };
}
