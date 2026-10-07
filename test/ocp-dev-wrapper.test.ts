import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { tool } from "../packages/facade-plugin/src/tool"
import { buildWrapper } from "../scripts/ocp-dev/wrapper"

test("additional clone wrappers restore dynamically imported tool facades after every refresh", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "ocp-wrapper-"))
  const root = resolve(import.meta.dir, "..")
  const previousRoot = process.env.OCP_DEV_ROOT
  const previousState = process.env.OCP_DEV_STATE_DIR
  process.env.OCP_DEV_ROOT = root
  process.env.OCP_DEV_STATE_DIR = join(temporary, "state")
  const stock = join(temporary, "stock")
  const source = `export function createAcme() { return { languageModel() {} } }
export default async function plugin() {
  const { tool } = await import("@opencode-ai/plugin")
  return { tool: { lookup: tool({
    description: "Look up a value",
    args: { query: tool.schema.string() },
    async execute() { return "ok" },
  }) } }
}
`
  mkdirSync(join(stock, "dist"), { recursive: true })
  writeFileSync(join(stock, "package.json"), JSON.stringify({
    name: "acme-provider", type: "module", main: "./dist/index.js",
  }))
  writeFileSync(join(stock, "dist/index.js"), source)
  try {
    for (const host of ["mimo", "kilo"]) {
      const wrapper = join(temporary, "state", host, "additional-provider")
      for (let refresh = 0; refresh < 2; refresh++) {
        const entry = await buildWrapper(host, stock, wrapper)
        for (const [name, facade] of [["plugin", "facade-plugin"], ["sdk", "facade-sdk"]]) {
          expect(realpathSync(join(wrapper, "node_modules/@opencode-ai", name!)))
            .toBe(realpathSync(join(root, "packages", facade!)))
        }
        const module = await import(`${pathToFileURL(entry).href}?refresh=${refresh}`)
        const hooks = await module.default()
        const schema = tool.schema.object(hooks.tool.lookup.args)
        expect(tool.schema.toJSONSchema(schema).properties?.query).toEqual({ type: "string" })
        expect(schema.parse({ query: "value" })).toEqual({ query: "value" })
        expect(schema.safeParse({ query: 1 }).success).toBe(false)
      }
    }
    expect(readFileSync(join(stock, "dist/index.js"), "utf8")).toBe(source)
    expect(existsSync(join(stock, "node_modules"))).toBe(false)
  } finally {
    if (previousRoot === undefined) delete process.env.OCP_DEV_ROOT
    else process.env.OCP_DEV_ROOT = previousRoot
    if (previousState === undefined) delete process.env.OCP_DEV_STATE_DIR
    else process.env.OCP_DEV_STATE_DIR = previousState
    rmSync(temporary, { recursive: true, force: true })
  }
})
