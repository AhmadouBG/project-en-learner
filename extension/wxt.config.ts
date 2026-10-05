import { defineConfig } from "wxt";

// English Shadowing - v1.0 (Tier 0)
// Single purpose: practise English pronunciation on any web page.
// select text -> listen -> shadow it -> review what you practised.
//
// Zero runtime dependencies: every browser capability used (speechSynthesis,
// MediaRecorder, AnalyserNode, SpeechRecognition, chrome.sidePanel) is native.
export default defineConfig({
  // Keep spec section 6 layout: everything lives under src/.
  srcDir: "src",

  manifest: ({ browser }) => ({
    name: "__MSG_extName__",
    description: "__MSG_extDescription__",
    default_locale: "en",

    // No `host_permissions` for <all_urls>: the micro-button needs a content
    // script on every page, which `content_scripts.matches` already grants
    // without an install-time warning. The ONLY host permission we request is
    // the dictionary API (spec section 5.3). See docs/DECISIONS.md.
    permissions: ["storage", "contextMenus", "sidePanel"],
    host_permissions: ["https://freedictionaryapi.com/*"],

    action: {
      default_title: "__MSG_actionTitle__",
      default_icon: {
        "16": "icon/16.png",
        "32": "icon/32.png",
        "48": "icon/48.png",
        "128": "icon/128.png",
      },
    },

    icons: {
      "16": "icon/16.png",
      "32": "icon/32.png",
      "48": "icon/48.png",
      "128": "icon/128.png",
    },

    side_panel: { default_path: "sidepanel.html" },
    options_ui: { page: "sidepanel.html", open_in_tab: false },

    commands: {
      "open-panel": {
        suggested_key: { default: "Alt+Shift+S" },
        description: "__MSG_commandOpenPanel__",
      },
    },

    // Firefox-only keys are stripped by WXT when targeting chrome.
    browser_specific_settings:
      browser === "firefox"
        ? { gecko: { id: "english-shadowing@example.invalid", strict_min_version: "128.0" } }
        : undefined,
  }),

  vite: () => ({
    build: {
      // Readable output size accounting; we report real numbers per phase.
      reportCompressedSize: true,
    },
  }),
});