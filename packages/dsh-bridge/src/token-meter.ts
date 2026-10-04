/**
 * Cordis token-meter provider, selected by this package's bundle patch.
 * Delegates to the stock public service and projection definitions; never
 * mutates host services, their state, or the durable log's billing samples.
 */
import { z } from "zod"
import { usageCount, type UsageContext } from "@opencode-compat/opencode-loader"

type Event = { type: string; seq: number; data: {
  header?: unknown; usage?: unknown; stream?: Array<{ chunk?: unknown }>; [key: string]: unknown
}; [key: string]: unknown }
type Session = { id: string; seq: number; snapshotEvents(from?: number, to?: number): Event[] }
type Measurement = {
  totalTokens: number; surfaceTokens: number; surfaceDeltaTokens: number;
  baseline: { kind: string; tokens: number }; [key: string]: unknown
}
type Pressure = { pressureTokens?: number; projectedTokens?: number; [key: string]: unknown }
type Definition = {
  key: string; stateVersion: number; stateSchema: z.ZodType;
  init(...args: unknown[]): unknown; apply(state: unknown, event: Event): unknown;
  wire: { viewSchema: z.ZodType; view(state: unknown): Pressure }
}
type Registry = { register(definition: Definition): unknown }
type Context = {
  sessionProjections: Registry;
  extend(properties: Record<string, unknown>): Context;
  plugin(plugin: unknown, config?: unknown): PromiseLike<unknown>;
  get?(name: string): unknown;
}
type Meter = { measure(session: Session, header?: unknown): Measurement }
type Runtime = {
  TokenMeter: new (ctx: Context, config?: unknown) => Meter;
  canonicalHeader(header: unknown): unknown;
  headerEquals(a: unknown, b: unknown): boolean;
  createSession(id: string, events: Event[]): Session;
}

/** The response sidecar uses DSH's open ReplayEnvelope, not extra billing fields. */
export function contextSample(event: Event): UsageContext | { carry: true } | undefined {
  if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return undefined
  for (const record of [...event.data.stream ?? []].reverse()) {
    const chunk = record.chunk as { type?: string; replayState?: { response?: { ocpContext?: unknown } } } | undefined
    if (chunk?.type !== "finish") continue
    const value = chunk.replayState?.response?.ocpContext as Partial<UsageContext> & { carry?: boolean } | undefined
    if (value?.carry === true) return { carry: true }
    const contextTokens = usageCount(value?.contextTokens)
    const promptTokens = usageCount(value?.promptTokens)
    return contextTokens !== undefined && promptTokens !== undefined && promptTokens <= contextTokens
      ? { contextTokens, promptTokens } : undefined
  }
  return undefined
}

/** Wrap the registered public pure fold; opaque host state stays opaque. */
export function contextProjection(definition: Definition): Definition {
  const stateSchema = z.object({
    host: definition.stateSchema,
    offsets: z.object({ prompt: z.number().int(), context: z.number().int() }).optional(),
  }).strict()
  type State = z.infer<typeof stateSchema>
  return {
    ...definition,
    stateVersion: definition.stateVersion * 1000 + 1,
    stateSchema,
    init: (...args) => ({ host: definition.init(...args) }),
    apply: (value, event) => {
      const state = value as State
      const host = definition.apply(state.host, event)
      const sample = contextSample(event)
      const before = definition.wire.view(state.host)
      const after = definition.wire.view(host)
      let offsets = state.offsets
      if (sample && after.pressureTokens !== undefined && after.projectedTokens !== undefined) {
        const prompt = "carry" in sample ? before.pressureTokens === undefined ? undefined : before.pressureTokens + (offsets?.prompt ?? 0) : sample.promptTokens
        const context = "carry" in sample ? before.projectedTokens === undefined ? undefined : before.projectedTokens + (offsets?.context ?? 0) : sample.contextTokens
        offsets = prompt === undefined || context === undefined ? undefined
          : { prompt: prompt - after.pressureTokens, context: context - after.projectedTokens }
      } else if ((event.type === "assistant/message" || event.type === "assistant/attempt")
        && (event.data.usage !== undefined || event.data.stream?.some(record => (record.chunk as { type?: string })?.type === "usage"))) {
        offsets = undefined
      }
      if (host === state.host && offsets === state.offsets) return state
      return { host, ...(offsets ? { offsets } : {}) }
    },
    wire: {
      ...definition.wire,
      view: value => {
        const state = value as State
        const view = definition.wire.view(state.host)
        if (!state.offsets) return view
        return {
          ...view,
          ...(view.pressureTokens === undefined ? {} : { pressureTokens: Math.max(0, view.pressureTokens + state.offsets.prompt) }),
          ...(view.projectedTokens === undefined ? {} : { projectedTokens: Math.max(0, view.projectedTokens + state.offsets.context) }),
        }
      },
    },
  }
}

export function createTokenMeter(runtime: Runtime): new (ctx: Context, config?: unknown) => Meter {
  return class BridgeTokenMeter extends runtime.TokenMeter {
    private readonly anchors = new WeakMap<Session, {
      revision: number; header: unknown; anchorHeader?: unknown;
      sample?: UsageContext; prefix?: Session
    }>()

    constructor(ctx: Context, config?: unknown) {
      const registry = ctx.sessionProjections
      const projections = new Proxy(registry, {
        get(target, key) {
          if (key === "register") return (definition: Definition) => target.register(
            definition.key === "contextPressure" ? contextProjection(definition) : definition,
          )
          const member = Reflect.get(target, key)
          return typeof member === "function" ? member.bind(target) : member
        },
      })
      super(ctx.extend({ sessionProjections: projections }), config)
    }

    override measure(session: Session, header?: unknown): Measurement {
      const measured = super.measure(session, header)
      let state = this.anchors.get(session)
      if (!state || state.revision > session.seq) state = { revision: 0, header: undefined }
      let anchorIndex: number | undefined
      for (const event of session.snapshotEvents(state.revision)) {
        const index = event.seq
        if (event.type === "request/header") state.header = runtime.canonicalHeader(event.data.header)
        if (event.type !== "assistant/message") continue
        const sample = contextSample(event)
        if (sample && (!("carry" in sample) || state.sample && runtime.headerEquals(state.anchorHeader, state.header))) {
          if (!("carry" in sample)) state.sample = sample
          else if (state.sample) {
            if (anchorIndex !== undefined) state.prefix = runtime.createSession(session.id, session.snapshotEvents(0, anchorIndex + 1))
            if (state.prefix) {
              const before = runtime.createSession(session.id, session.snapshotEvents(0, index))
              const growth = super.measure(before, state.header).surfaceTokens - super.measure(state.prefix, state.header).surfaceTokens
              state.sample = {
                promptTokens: Math.max(0, state.sample.promptTokens + growth),
                contextTokens: Math.max(0, state.sample.contextTokens + growth),
              }
            }
          }
          state.anchorHeader = state.header
          anchorIndex = index
        } else {
          state.sample = undefined
          state.prefix = undefined
          anchorIndex = undefined
        }
      }
      if (anchorIndex !== undefined) state.prefix = runtime.createSession(session.id, session.snapshotEvents(0, anchorIndex + 1))
      state.revision = session.seq
      this.anchors.set(session, state)
      const effectiveHeader = header === undefined ? state.header : runtime.canonicalHeader(header)
      if (!state.sample || !state.prefix || state.anchorHeader === undefined || effectiveHeader === undefined
        || !runtime.headerEquals(state.anchorHeader, effectiveHeader)) return measured
      // Both surfaces reprice under the same public request envelope. Usage
      // can be below the host heuristic: a checkpoint remains authoritative.
      const anchor = super.measure(state.prefix, effectiveHeader)
      const surfaceDeltaTokens = measured.surfaceTokens - anchor.surfaceTokens
      return Object.freeze({
        ...measured,
        baseline: Object.freeze({
          kind: "usage", tokens: state.sample.contextTokens,
          usage: Object.freeze({
            inputTokens: state.sample.promptTokens,
            outputTokens: state.sample.contextTokens - state.sample.promptTokens,
            totalTokens: state.sample.contextTokens,
          }),
        }),
        surfaceDeltaTokens,
        totalTokens: Math.max(0, state.sample.contextTokens + surfaceDeltaTokens),
      })
    }
  }
}

type StockSession = {
  canonicalHeader: Runtime["canonicalHeader"]; headerEquals: Runtime["headerEquals"]
  Session: { create(id: string, events: Event[], header?: unknown, inherited?: unknown, projections?: readonly unknown[]): Session }
}

/** Bind the stock modules; detached replay borrows the store's message interpreters. */
export function stockRuntime(ctx: Context, meter: { default?: Runtime["TokenMeter"]; TokenMeter?: Runtime["TokenMeter"] },
  session: StockSession): Runtime {
  return {
    TokenMeter: (meter.default ?? meter.TokenMeter)!,
    canonicalHeader: session.canonicalHeader, headerEquals: session.headerEquals,
    // Session seeds are validated eagerly. Plugin-owned message events (for
    // example image/offload) need the same interpreters live sessions use.
    createSession: (id, events) => session.Session.create(id, events, undefined, undefined,
      (ctx.get?.("sessions") as { messageProjections?: readonly unknown[] } | undefined)?.messageProjections),
  }
}

export const name = "dsh-bridge-token-meter"
export const inject = ["sessionProjections"]
export async function apply(ctx: Context, config?: unknown): Promise<void> {
  // Resolve the stock runtime in the profile's package graph only when this
  // Cordis provider is selected. Generic bridge imports do not require DSH.
  const meterPackage = "@deepseek-ai/dsh-token-meter"
  const sessionPackage = "@deepseek-ai/dsh-session"
  const [meter, session] = await Promise.all([import(meterPackage), import(sessionPackage)])
  await ctx.plugin(createTokenMeter(stockRuntime(ctx, meter, session)), config)
}
export default { name, inject, apply }
