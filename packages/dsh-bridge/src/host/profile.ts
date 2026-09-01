/**
 * DSH host profile — single host, variance as data.
 * Mirrors `packages/pi-bridge/src/host/profile.ts` (PiHostProfile) but for DeepSeek Harness.
 * One profile, one package, no per-host fork.
 */

export type DshHostId = "dsh"

export type DshHostProfile = {
  id: DshHostId
  name: string
  /** Cordis plugin package providing the LLM service. */
  llmPackage: string
  /** Credential scope for OAuth grants stored via ctx.credentials. */
  credentialScope: string
  /** Provider ids DSH already ships (collision guard). */
  reservedProviderIds: readonly string[]
  /** Wire ids DSH reserves for built-in APIs. */
  reservedApis: readonly string[]
}

const DSH_RESERVED_PROVIDER_IDS = [
  "deepseek-official",
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "groq",
  "cerebras",
  "xai",
  "mistral",
  "ollama",
  "cursor",
  "github-copilot",
  "devin",
] as const

const DSH_RESERVED_APIS: readonly string[] = []

export function dshProfile(): DshHostProfile {
  return {
    id: "dsh",
    name: "DeepSeek Harness",
    llmPackage: "@deepseek-ai/dsh-llm",
    credentialScope: "dsh-bridge",
    reservedProviderIds: DSH_RESERVED_PROVIDER_IDS,
    reservedApis: DSH_RESERVED_APIS,
  }
}

export function avoidProviderIdCollision(providerId: string, profile: DshHostProfile, suffix = "-opencode"): string {
  return (profile.reservedProviderIds as readonly string[]).includes(providerId) ? `${providerId}${suffix}` : providerId
}
