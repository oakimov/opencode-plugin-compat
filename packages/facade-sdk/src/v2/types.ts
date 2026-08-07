/**
 * Minimal `@opencode-ai/sdk/v2/types` stand-in.
 * Expands via fixtures; enough for catalog-consuming classic plugins.
 */

export type ModelCost = {
  input: number
  output: number
  cache?: {
    read: number
    write: number
  }
  tier?: {
    type?: string
    size?: number
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type ModelCapabilities = {
  tools: boolean
  input: string[]
  output: string[]
  [key: string]: unknown
}

export type ModelApi = {
  id?: string
  type: "native" | "aisdk" | string
  url?: string
  settings?: Record<string, unknown>
  package?: string
  [key: string]: unknown
}

export type ModelV2Info = {
  id: string
  providerID: string
  family?: string
  name: string
  api: ModelApi
  capabilities: ModelCapabilities
  request: {
    headers: { [key: string]: string }
    body: { [key: string]: unknown }
    variant?: string
  }
  variants: Array<{
    id: string
    headers: { [key: string]: string }
    body: { [key: string]: unknown }
  }>
  time: {
    released: number
  }
  cost: Array<ModelCost>
  status: "alpha" | "beta" | "deprecated" | "active"
  enabled: boolean
  limit: {
    context: number
    input?: number
    output: number
  }
  [key: string]: unknown
}
