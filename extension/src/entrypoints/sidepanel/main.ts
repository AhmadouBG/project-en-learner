import { mountApp } from "../../sidepanel/app";

/**
 * Side-panel entrypoint.
 *
 * All behaviour lives in `src/sidepanel/app.ts`, which is testable in isolation
 * from WXT's entrypoint loader.
 */
void mountApp();
