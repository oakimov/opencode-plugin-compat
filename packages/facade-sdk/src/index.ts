/**
 * Minimal install-override stand-in for `@opencode-ai/sdk`.
 * Starts from types used by classic auth plugins; expands via fixtures.
 */
export const PKG = "@opencode-compat/facade-sdk" as const
export const VERSION = "0.1.3" as const

export type OAuth = {
  type: "oauth"
  refresh: string
  access: string
  expires: number
  enterpriseUrl?: string
  accountId?: string
}

export type ApiAuth = {
  type: "api"
  key: string
  metadata?: { [key: string]: string }
}

export type WellKnownAuth = {
  type: "wellknown"
  key: string
  token: string
}

export type Auth = OAuth | ApiAuth | WellKnownAuth

export type Model = {
  id: string
  providerID: string
  name: string
  [key: string]: unknown
}

export type Provider = {
  id: string
  name: string
  source: "env" | "config" | "custom" | "api"
  env: string[]
  key?: string
  options: Record<string, unknown>
  models: Record<string, Model>
  [key: string]: unknown
}

export type Project = {
  id: string
  worktree: string
  vcsDir?: string
  vcs?: "git"
  time: {
    created: number
    initialized?: number
  }
}

/**
 * Opaque host client. Real method surface comes from the native SDK
 * (`@opencode-ai/sdk`, `@mimo-ai/sdk`, or `@kilocode/sdk`).
 */
export type OpencodeClient = {
  readonly [key: string]: unknown
}

export type OpencodeClientConfig = {
  baseUrl?: string
  directory?: string
  [key: string]: unknown
}

type ClientFactory = (
  config?: OpencodeClientConfig & { directory?: string },
) => OpencodeClient

let injectedFactory: ClientFactory | undefined

/** OCP layer / tests may inject the native client factory. */
export function setCreateOpencodeClient(factory: ClientFactory | undefined): void {
  injectedFactory = factory
}

/**
 * Sync client factory matching `@opencode-ai/sdk` signature.
 *
 * Classic plugins mostly need `ReturnType<typeof createOpencodeClient>` for
 * `PluginInput.client`. Runtime construction should use a host-injected factory
 * (`setCreateOpencodeClient`) or `createOpencodeClientAsync`.
 */
export function createOpencodeClient(
  config?: OpencodeClientConfig & { directory?: string },
): OpencodeClient {
  if (injectedFactory) return injectedFactory(config)
  throw new Error(
    `${PKG}: createOpencodeClient has no native factory. ` +
      "Call setCreateOpencodeClient(...) from the host bridge, or use createOpencodeClientAsync().",
  )
}

/** Async path: load native SDK and invoke createOpencodeClient / createKiloClient. */
export async function createOpencodeClientAsync(
  config?: OpencodeClientConfig & { directory?: string },
): Promise<OpencodeClient> {
  if (injectedFactory) return injectedFactory(config)
  const { importNativeSdk } = await import("@opencode-compat/adapter")
  const native = await importNativeSdk()
  const factory =
    (native.createOpencodeClient as ClientFactory | undefined) ??
    (native.createKiloClient as ClientFactory | undefined)
  if (typeof factory !== "function") {
    throw new Error(
      `${PKG}: native SDK has no createOpencodeClient/createKiloClient export`,
    )
  }
  injectedFactory = factory
  return factory(config)
}