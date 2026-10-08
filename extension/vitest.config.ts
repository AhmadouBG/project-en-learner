import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    // Spec 9: unit tests for IPA conversion, alignment/diff, shadow state
    // machine, storage migrations. Spec 8: DOM-free logic must stay DOM-free.
    include: ["tests/**/*.test.ts"],
    // Default to node: most of this codebase is deliberately DOM-free
    // (spec 8). A test that needs the DOM opts in with a docblock comment:
    //   /** @vitest-environment happy-dom */
    // at the top of the file.
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/entrypoints/**",
        "src/data/generated/**",
        // The injected-UI layer is verified against a real browser by
        // scripts/check-selection.mjs (real selection, real shadow root, real
        // geometry). A synthetic DOM cannot tell us whether the button is 28 px
        // or whether page CSS leaked in, so a unit-test percentage here would be
        // misleading rather than informative.
        "src/content/micro-button.ts",
      ],
      thresholds: {
        // Keep the bar honest but achievable while the suite grows.
        statements: 70,
        branches: 70,
        functions: 70,
        lines: 70,
      },
    },
  },
});