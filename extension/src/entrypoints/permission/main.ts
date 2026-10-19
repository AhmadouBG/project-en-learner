/**
 * Microphone permission helper (spec 5.5).
 *
 * The side panel can request microphone access directly, but a dismissed prompt
 * cannot be shown again from the panel in some Chrome versions. This tiny
 * extension page requests it from a normal tab, where the browser's permission
 * UI is reliable, then tells the user to return.
 */

import { applyTranslations, loadMessages, makeTranslator } from "../../shared/i18n";
import { readStore } from "../../shared/storage";

async function main(): Promise<void> {
  const settings = (await readStore().catch(() => null))?.settings;
  const messages = await loadMessages(settings?.uiLanguage ?? "en");
  const t = makeTranslator(messages);
  applyTranslations(document, t);
  document.title = `${t("permissionTitle")} — ${t("extName")}`;

  const allow = document.getElementById("permission-allow");
  const back = document.getElementById("permission-return");
  const status = document.getElementById("permission-status");

  const setStatus = (message: string, kind: "ok" | "error" | "" = ""): void => {
    if (!status) return;
    status.textContent = message;
    status.className = kind;
  };

  back?.addEventListener("click", () => {
    window.close();
    setStatus(t("permissionReturn"));
  });

  allow?.addEventListener("click", () => {
    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus(t("errMicUnavailable"), "error");
        return;
      }
      setStatus(t("permissionBody"));
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        setStatus(t("permissionGranted"), "ok");
      } catch (error) {
        const name =
          typeof error === "object" && error !== null && "name" in error
            ? (error as { name?: unknown }).name
            : "";
        setStatus(
          name === "NotAllowedError" || name === "SecurityError"
            ? t("permissionDenied")
            : t("errMicUnavailable"),
          "error",
        );
      }
    })();
  });
}

void main();
