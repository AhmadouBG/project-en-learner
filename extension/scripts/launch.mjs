/**
 * Build, then launch Chrome with the extension already loaded.
 *
 * The gotcha this removes: WXT *generates* the manifest, so there is no
 * `extension/manifest.json`. The loadable folder is `.output/chrome-mv3`.
 *
 * Usage:
 *   node scripts/launch.mjs           build + launch
 *   node scripts/launch.mjs --dev     build in watch mode, launch, keep running
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = join(ROOT, ".output", "chrome-mv3");
const DEV = process.argv.includes("--dev");

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const findChrome = () => CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} exited with ${code}`)),
    );
  });
}

async function main() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  console.log(`> ${npm} run ${DEV ? "dev" : "build"}`);
  await run(npm, ["run", DEV ? "dev" : "build"]);

  if (!existsSync(join(BUILD_DIR, "manifest.json"))) {
    console.error(`\nBuild reported success but there is no manifest in:\n  ${BUILD_DIR}`);
    process.exit(1);
  }

  const chrome = findChrome();
  if (!chrome) {
    console.error(`\nNo Chrome found. Load this folder by hand in chrome://extensions:\n  ${BUILD_DIR}`);
    process.exit(1);
  }

  console.log(`\nLoadable extension folder:\n  ${BUILD_DIR}\n`);
  console.log("Opening chrome://extensions ...");

  const child = spawn(chrome, ["chrome://extensions"], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  if (DEV) {
    console.log("\nWatching for changes. Ctrl+C to stop.");
    await new Promise(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});