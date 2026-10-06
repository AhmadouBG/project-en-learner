/**
 * Side panel tab shell (Phase 1).
 *
 * Implements the ARIA tabs pattern correctly: roving tabindex, arrow/Home/End
 * keys, and `aria-selected` kept in sync (spec 3: keyboard accessibility from
 * the start). The real tab bodies are added in later phases; this file owns the
 * navigation so those phases only have to fill in sections.
 */

const TABS = ["practise", "saved", "settings"] as const;
type TabId = (typeof TABS)[number];

function isTabId(value: string): value is TabId {
  return (TABS as readonly string[]).includes(value);
}

const tablist = document.getElementById("tablist");
const buttons = TABS.map((id) => document.getElementById(`tab-${id}`));

function select(id: TabId, { focus = false }: { focus?: boolean } = {}): void {
  for (const [index, tab] of TABS.entries()) {
    const button = buttons[index];
    const panel = document.getElementById(`panel-${tab}`);
    const active = tab === id;
    button?.setAttribute("aria-selected", String(active));
    button?.setAttribute("tabindex", active ? "0" : "-1");
    if (panel) panel.hidden = !active;
  }
  if (focus) document.getElementById(`tab-${id}`)?.focus();
}

function move(from: TabId, delta: number): void {
  const current = TABS.indexOf(from);
  const next = TABS[(current + delta + TABS.length) % TABS.length];
  if (next) select(next, { focus: true });
}

for (const button of buttons) {
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
        select(TABS[0], { focus: true });
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

// Keep the browser's own focus order in step with the visual selection.
tablist?.addEventListener("focusin", (event) => {
  const id = (event.target as HTMLElement | null)?.dataset["tab"];
  if (id && isTabId(id)) select(id);
});

// Spec 3: theme from the start. Phase 11 replaces this with the user's setting.
document.documentElement.dataset["theme"] = "system";