import { describe, expect, test } from "bun:test"
import { DshLlmAdapter } from "../packages/dsh-bridge/src/adapter.ts"

describe("DshLlmAdapter prepareCall", () => {
  test("matches DSH LlmAdapter default: model from resolveModel plus stream", async () => {
    const adapter = new DshLlmAdapter({
      providerName: "cursor-opencode",
      getLanguageModel: () => {
        throw new Error("prepareCall must not open the model")
      },
    })
    adapter.resolveModel = async (provider, model) => ({ provider, id: model, name: `named-${model}` })
    const prepared = await adapter.prepareCall("cursor-opencode", "composer-2")
    expect(prepared.model).toEqual({ provider: "cursor-opencode", id: "composer-2", name: "named-composer-2" })
    expect(typeof prepared.stream).toBe("function")
  })
})
