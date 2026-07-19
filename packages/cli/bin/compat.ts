#!/usr/bin/env bun
/**
 * Published entry uses dist/ (src/ is not in the npm tarball).
 * From a checkout: run `bun run build` first, or `bun packages/cli/src/…` via tests.
 */
import { mainAsync } from "../dist/index.js"

process.exit(await mainAsync())
