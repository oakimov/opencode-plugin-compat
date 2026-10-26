import { expect, test } from "bun:test"
import { createToolCatalogOrder } from "../packages/opencode-loader/src/tool-catalog-order.ts"

test("catalog snapshots survive source mutation, removal, lifecycle calls, and restoration", () => {
  const order = createToolCatalogOrder<{ name: string; schema?: { required: string[] } }>()
  const source = { name: "z", schema: { required: ["original"] } }
  expect(order([source], "one")).toEqual([source])
  source.schema.required.push("later")
  expect(order([{ name: "a" }, source], "one")).toEqual([
    { name: "z", schema: { required: ["original"] } }, { name: "a" },
  ])
  expect(order([], "one")).toEqual([])
  expect(order(undefined, "one")).toBeUndefined()
  expect(order([{ name: "a" }], "one")).toEqual([{ name: "a" }])
  expect(order([{ name: "a" }, source], "one")?.[0]).toEqual({ name: "z", schema: { required: ["original"] } })
  expect(order([{ name: "a" }, source], "two")?.map(tool => tool.name)).toEqual(["a", "z"])
})

test("catalog ordering preserves duplicate definitions and bounds expired sessions", () => {
  const order = createToolCatalogOrder<{ name: string }>()
  expect(order([{ name: "z" }, { name: "z" }], "duplicates")).toEqual([{ name: "z" }, { name: "z" }])
  expect(order([{ name: "z" }, { name: "a" }])?.map(tool => tool.name)).toEqual(["a", "z"])
  order([{ name: "z" }], "oldest")
  for (let index = 0; index < 256; index++) order([{ name: "z" }], String(index))
  expect(order([{ name: "a" }, { name: "z" }], "oldest")?.map(tool => tool.name)).toEqual(["a", "z"])
})
