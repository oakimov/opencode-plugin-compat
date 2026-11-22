// Trusted review-harness catalog-order checks, run inside isolate-run.sh
// against the archived subject's built opencode-loader. The oracle is the
// AGENTS.md catalog rule, not the subject's tests or a second catalog from the
// same code:
//
//   Sort the first nonempty catalog once by canonical name in UTF-16
//   code-unit order; never re-sort that established prefix. Sort only a
//   newcomer batch and append it (initial z, then a, stays z, a). Keep
//   equal-name descriptors frozen. A call with no tools stays empty and is a
//   lifecycle signal, not a new catalog.
//
// Each case prints CATALOG_CONTRACT=<case>:passed|failed|skipped <detail>.
// The last line is REVIEW_CONTRACT_COMPLETE=CATALOG_CONTRACTS:<status>.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const LABEL = "CATALOG_CONTRACTS"
// Every case name, so a subject without the loader skips the same names the
// base passed and the wrapper can see the capability disappear.
const CASES = [
  "first-catalog-sorted-by-code-unit",
  "newcomer-appended-not-resorted",
  "newcomer-batch-sorted-at-tail",
  "equal-name-descriptor-frozen",
  "empty-call-is-lifecycle",
  "disappear-reappear-keeps-prefix",
  "sessions-are-independent",
]
const src = process.argv[2]
const entry = src ? join(src, "packages/opencode-loader/dist/index.js") : ""
let failed = 0

function report(name, status, detail = "") {
  if (status === "failed") failed += 1
  console.log(`CATALOG_CONTRACT=${name}:${status}${detail ? ` ${detail}` : ""}`)
}

function finish() {
  console.log(`REVIEW_CONTRACT_COMPLETE=${LABEL}:${failed === 0 ? "passed" : "failed"}`)
  process.exit(failed === 0 ? 0 : 1)
}

if (!src || !existsSync(join(src, "package.json"))) {
  console.log(`CATALOG_CONTRACT=subject:unavailable no package.json at ${src ?? "<missing argument>"}`)
  process.exit(2)
}
function skipAll(reason) {
  for (const name of CASES) report(name, "skipped", reason)
  finish()
}

if (!existsSync(entry)) skipAll("packages/opencode-loader/dist/index.js absent")

const loader = await import(pathToFileURL(entry).href)
if (typeof loader.createToolCatalogOrder !== "function") skipAll("createToolCatalogOrder is not exported")

const tool = (name, description = `${name} tool`) => ({ name, description, inputSchema: { type: "object", properties: { [name]: { type: "string" } } } })
const names = tools => (tools ?? []).map(entry => entry.name)
/** UTF-16 code-unit order: the comparison JS `<` performs on strings. */
const codeUnitSorted = list => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function check(name, run) {
  if (!CASES.includes(name)) throw new Error(`unlisted case ${name}`)
  try {
    const problem = run()
    report(name, problem ? "failed" : "passed", problem ?? "")
  } catch (error) {
    report(name, "failed", `threw ${error instanceof Error ? error.message : String(error)}`)
  }
}

check("first-catalog-sorted-by-code-unit", () => {
  const order = loader.createToolCatalogOrder()
  const input = ["b", "a", "Z", "é", "B", "_x", "a10", "a2"]
  const got = names(order(input.map(n => tool(n)), "s"))
  const want = codeUnitSorted(input)
  return same(got, want) ? undefined : `got=${got.join(",")}; want=${want.join(",")}`
})

check("newcomer-appended-not-resorted", () => {
  const order = loader.createToolCatalogOrder()
  order([tool("z")], "s")
  const got = names(order([tool("a"), tool("z")], "s"))
  return same(got, ["z", "a"]) ? undefined : `got=${got.join(",")}; want=z,a`
})

check("newcomer-batch-sorted-at-tail", () => {
  const order = loader.createToolCatalogOrder()
  order([tool("m"), tool("c")], "s")
  const got = names(order([tool("y"), tool("c"), tool("b"), tool("m")], "s"))
  return same(got, ["c", "m", "b", "y"]) ? undefined : `got=${got.join(",")}; want=c,m,b,y`
})

check("equal-name-descriptor-frozen", () => {
  const order = loader.createToolCatalogOrder()
  order([tool("a", "first description")], "s")
  const got = order([tool("a", "changed description")], "s")
  return got?.[0]?.description === "first description" ? undefined : `description=${JSON.stringify(got?.[0]?.description)}`
})

check("empty-call-is-lifecycle", () => {
  const order = loader.createToolCatalogOrder()
  order([tool("z")], "s")
  const empty = order([], "s")
  if (!Array.isArray(empty) || empty.length !== 0) return `empty call returned ${JSON.stringify(names(empty))}`
  const got = names(order([tool("a"), tool("z")], "s"))
  return same(got, ["z", "a"]) ? undefined : `prefix lost after lifecycle call: got=${got.join(",")}; want=z,a`
})

check("disappear-reappear-keeps-prefix", () => {
  const order = loader.createToolCatalogOrder()
  order([tool("z"), tool("a")], "s")
  const without = names(order([tool("a")], "s"))
  const back = names(order([tool("a"), tool("z")], "s"))
  if (!same(without, ["a"])) return `active filter got=${without.join(",")}; want=a`
  return same(back, ["a", "z"]) ? undefined : `got=${back.join(",")}; want=a,z`
})

check("sessions-are-independent", () => {
  const order = loader.createToolCatalogOrder()
  order([tool("z")], "one")
  order([tool("a"), tool("z")], "one")
  const other = names(order([tool("a"), tool("z")], "two"))
  return same(other, ["a", "z"]) ? undefined : `got=${other.join(",")}; want=a,z`
})

finish()
