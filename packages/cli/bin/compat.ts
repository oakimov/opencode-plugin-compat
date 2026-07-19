#!/usr/bin/env bun
import { doctor } from "../src/index.ts"

const result = doctor()
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
