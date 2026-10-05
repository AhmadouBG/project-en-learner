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
      exclude: ["src/entrypoints/**", "src/data/generated/**"],
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