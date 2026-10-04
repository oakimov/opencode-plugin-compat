import { expect, test } from "bun:test"
import { z } from "zod"
import { contextProjection, contextSample, createTokenMeter, stockRuntime } from "../packages/dsh-bridge/src/token-meter.ts"

const sample = (contextTokens: number, promptTokens: number) => ({
  type: "assistant/message", seq: 0, data: { usage: { inputTokens: 300_000 },
    stream: [{ chunk: { type: "finish", replayState: { response: { ocpContext: { contextTokens, promptTokens } } } } }] },
})
// An opaque public host fold: the wrapper must delegate all unrelated state.
const definition = {
  key: "contextPressure", stateVersion: 5,
  stateSchema: z.object({ prompt: z.number(), projected: z.number(), window: z.number(), calls: z.number() }),
  init: () => ({ prompt: 0, projected: 0, window: 256_000, calls: 0 }),
  apply(state: any, event: any) {
    if (event.type === "assistant/message") return { ...state, prompt: event.data.usage.inputTokens, projected: event.data.usage.inputTokens + 10, calls: state.calls + 1 }
    if (event.type === "surface/change") return { ...state, projected: state.projected + event.data.delta, calls: state.calls + 1 }
    if (event.type === "request/context") return { ...state, window: event.data.window, calls: state.calls + 1 }
    return state
  },
  wire: { viewSchema: z.any(), view: (state: any) => ({ pressureTokens: state.prompt, projectedTokens: state.projected, contextWindow: state.window }) },
}

test("public projection keeps exact occupancy, signed surface changes, and opaque host state on replay", () => {
  const fold = contextProjection(definition)
  let state = fold.apply(fold.init(), sample(54_129, 54_128))
  expect(fold.wire.view(state)).toEqual({ pressureTokens: 54_128, projectedTokens: 54_129, contextWindow: 256_000 })
  state = fold.apply(state, { type: "surface/change", seq: 1, data: { delta: -1_000 } })
  state = fold.apply(state, { type: "request/context", seq: 2, data: { window: 512_000 } })
  const checkpoint = JSON.parse(JSON.stringify(state))
  expect(fold.stateSchema.safeParse(checkpoint).success).toBe(true)
  expect(fold.stateVersion).toBe(5001)
  expect(fold.wire.view(checkpoint)).toEqual({ pressureTokens: 54_128, projectedTokens: 53_129, contextWindow: 512_000 })
  expect(checkpoint.host.calls).toBe(3)
  const before = fold.wire.view(state)
  state = fold.apply(state, { ...sample(0, 0), data: { usage: { inputTokens: 0 }, stream: [{ chunk: { type: "finish", replayState: { response: { ocpContext: { carry: true } } } } }] } })
  expect(fold.wire.view(state)).toEqual(before)
  state = fold.apply(state, { type: "assistant/message", seq: 3, data: { usage: { inputTokens: 80 } } })
  expect(fold.wire.view(state)).toEqual({ pressureTokens: 80, projectedTokens: 90, contextWindow: 512_000 })
})

test("malformed context sidecars cannot replace public usage", () => {
  for (const invalid of [sample(10, 20), sample(NaN, 0), sample(10.1, 2), sample(-1, 0)]) expect(contextSample(invalid)).toBeUndefined()
  expect(contextSample({ ...sample(10, 9), type: "user/message" })).toBeUndefined()
  expect(contextSample({ ...sample(10, 9), type: "assistant/attempt" })).toEqual({ contextTokens: 10, promptTokens: 9 })
})

test("meter reuses authoritative low occupancy, carries growth across display echoes, and reprices other headers", () => {
  const session = (events: any[] = []) => ({ id: "mock", get seq() { return events.length }, snapshotEvents: (from = 0, to = events.length) => events.slice(from, to), events })
  class Stock {
    constructor(ctx: any) { ctx.sessionProjections.register(definition) }
    measure(s: ReturnType<typeof session>, header?: any) {
      const surfaceTokens = s.events.reduce((sum, event) => sum + (event.data.surface ?? 0), 0)
      return { totalTokens: 100_000 + surfaceTokens, surfaceTokens, surfaceDeltaTokens: 0, baseline: { kind: "estimated", tokens: 100_000 }, header }
    }
  }
  let registered: any
  const ctx: any = { sessionProjections: { register(value: any) { registered = value } }, extend(props: any) { return { ...this, ...props } } }
  const Meter = createTokenMeter({ TokenMeter: Stock as never, canonicalHeader: header => header, headerEquals: (a, b) => JSON.stringify(a) === JSON.stringify(b), createSession: (_id, events) => session(events) })
  const meter = new Meter(ctx)
  const s = session([{ type: "request/header", seq: 0, data: { header: { model: "a" } } }, { ...sample(10, 9), seq: 1, data: { ...sample(10, 9).data, surface: 5 } }])
  expect(registered.stateVersion).toBe(5001)
  expect(meter.measure(s).totalTokens).toBe(10)
  s.events.push({ type: "user/message", seq: 2, data: { surface: 20 } })
  expect(meter.measure(s).totalTokens).toBe(30)
  s.events.push({ type: "assistant/message", seq: 3, data: { surface: 100, stream: [{ chunk: { type: "finish", replayState: { response: { ocpContext: { carry: true } } } } }] } })
  expect(meter.measure(s).totalTokens).toBe(30)
  expect(meter.measure(s, { model: "b" }).totalTokens).toBe(100_125)
  expect(meter.measure(session(s.events)).totalTokens).toBe(30)
  s.events.push({ type: "surface/change", seq: 4, data: { surface: -20 } })
  expect(meter.measure(s).totalTokens).toBe(10)
  s.events.push({ type: "assistant/message", seq: 5, data: { usage: { inputTokens: 70 } } })
  expect(meter.measure(s).totalTokens).toBe(100_105)
})

test("detached prefix sessions replay with the store's plugin-owned message interpreters", () => {
  const offload = { type: "image/offload" }
  const created: unknown[][] = []
  const Meter = class {}
  const ctx: any = { get: (name: string) => name === "sessions" ? { messageProjections: [offload] } : undefined }
  const runtime = stockRuntime(ctx, { default: Meter as never }, {
    canonicalHeader: (header: unknown) => header, headerEquals: () => true,
    Session: { create: (...args: unknown[]) => { created.push(args); return {} as never } },
  })
  expect(runtime.TokenMeter).toBe(Meter as never)
  runtime.createSession("s", [])
  expect(created[0]).toEqual(["s", [], undefined, undefined, [offload]])
})
