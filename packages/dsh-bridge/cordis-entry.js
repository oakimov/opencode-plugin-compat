/**
 * Cordis / DSH package entry.
 * Re-exports the built module so scanners can see `apply` in a committed
 * file while runtime still loads the published `dist/` build.
 */
export { name, inject, Config, apply, default } from "./dist/index.js";
