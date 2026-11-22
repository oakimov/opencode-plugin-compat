/**
 * A bridge generation: validated config, resolved binding credentials and the
 * loaded plugin instances behind each model alias. A replacement generation is
 * built completely before it is published, so a failed reload leaves the old
 * healthy generation serving.
 */
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { BindingSpec, ZcodeBridgeConfig } from "./config.js"
import { CredentialError, credentialEquals, describeCredentialRef, resolveCredential } from "./credentials.js"
import { loadPlugin, PluginLoadError, type LoadedPlugin, type LoadPluginOptions, type ModelInfo } from "./plugin-host.js"

export type ModelRoute = {
  binding: BindingSpec
  /** Absent for a static source (the Step 0 probe). */
  plugin?: LoadedPlugin
  model: ModelInfo
  /** Identity of the routed target; changes when an alias is repointed on reload. */
  targetKey: string
  languageModel(): Promise<LanguageModelV3>
  /** Per-call provider options from the model's catalog entry. */
  providerOptions(): Record<string, Record<string, unknown>> | undefined
}

/** A model source that is not an OpenCode plugin (the Step 0 probe). */
export type StaticModelSource = {
  info: ModelInfo
  languageModel(): Promise<LanguageModelV3>
}

export type BindingRuntime = {
  spec: BindingSpec
  modelCredential: string
  mcpCredential?: string
  routes: Map<string, ModelRoute>
  plugins: LoadedPlugin[]
}

export type ReadinessIssue = {
  binding: string
  plugin?: string
  code: "credential" | PluginLoadError["code"] | "load-failed"
  message: string
}

export type Generation = {
  id: number
  config: ZcodeBridgeConfig
  bindings: BindingRuntime[]
}

export class GenerationBuildError extends Error {
  constructor(readonly issues: ReadinessIssue[]) {
    super(issues.map(issue => `binding "${issue.binding}"${issue.plugin ? ` plugin "${issue.plugin}"` : ""}: [${issue.code}] ${issue.message}`).join("\n"))
    this.name = "GenerationBuildError"
  }
}

export type BuildOptions = LoadPluginOptions & {
  env?: NodeJS.ProcessEnv
  /** Static routes keyed by binding id (probe / tests). */
  staticRoutes?: Map<string, StaticModelSource[]>
}

let nextGeneration = 1

export async function buildGeneration(config: ZcodeBridgeConfig, options: BuildOptions): Promise<Generation> {
  const issues: ReadinessIssue[] = []
  const bindings: BindingRuntime[] = []

  for (const spec of config.bindings) {
    let modelCredential: string | undefined
    let mcpCredential: string | undefined
    try {
      modelCredential = resolveCredential(spec.credentials.model, options.env)
      if (spec.credentials.mcp) mcpCredential = resolveCredential(spec.credentials.mcp, options.env)
    } catch (error) {
      issues.push({ binding: spec.id, code: "credential", message: error instanceof CredentialError ? error.message : String(error) })
      continue
    }

    const routes = new Map<string, ModelRoute>()
    const plugins: LoadedPlugin[] = []
    for (const pluginSpec of spec.plugins) {
      try {
        const plugin = await loadPlugin(spec, pluginSpec, options)
        plugins.push(plugin)
        for (const model of plugin.models.values()) {
          routes.set(model.alias, {
            binding: spec,
            plugin,
            model,
            targetKey: `${spec.id}\u0000${pluginSpec.id}\u0000${plugin.resolved.sha256}\u0000${model.upstream}`,
            languageModel: () => plugin.languageModel(model.alias),
            providerOptions: () => plugin.providerOptions(model.alias),
          })
        }
      } catch (error) {
        issues.push({
          binding: spec.id,
          plugin: pluginSpec.id,
          code: error instanceof PluginLoadError ? error.code : "load-failed",
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    for (const source of options.staticRoutes?.get(spec.id) ?? []) {
      routes.set(source.info.alias, {
        binding: spec,
        model: source.info,
        targetKey: `${spec.id}\u0000static\u0000${source.info.alias}`,
        languageModel: source.languageModel,
        providerOptions: () => undefined,
      })
    }
    bindings.push({ spec, modelCredential, ...(mcpCredential ? { mcpCredential } : {}), routes, plugins })
  }

  // Resolved values must also be distinct: one presented secret selects one binding.
  const all = bindings.flatMap(binding => [
    { binding: binding.spec.id, route: "model", value: binding.modelCredential, ref: binding.spec.credentials.model },
    ...(binding.mcpCredential && binding.spec.credentials.mcp ? [{ binding: binding.spec.id, route: "mcp", value: binding.mcpCredential, ref: binding.spec.credentials.mcp }] : []),
  ])
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (credentialEquals(all[i]!.value, all[j]!.value)) {
        issues.push({
          binding: all[j]!.binding,
          code: "credential",
          message: `${describeCredentialRef(all[j]!.ref)} (${all[j]!.route}) resolves to the same secret as binding "${all[i]!.binding}" (${all[i]!.route})`,
        })
      }
    }
  }

  if (issues.length > 0) throw new GenerationBuildError(issues)
  return { id: nextGeneration++, config, bindings }
}

/** Find the binding whose model credential matches. Compares against every binding. */
export function bindingForModelCredential(generation: Generation, presented: string): BindingRuntime | undefined {
  let match: BindingRuntime | undefined
  for (const binding of generation.bindings) {
    if (credentialEquals(presented, binding.modelCredential)) match = binding
  }
  return match
}
