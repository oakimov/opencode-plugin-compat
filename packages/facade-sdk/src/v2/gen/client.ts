/**
 * Opaque hey-api style transport used by `@opencode-ai/sdk/v2/gen/client`.
 * Classic plugin clients expose this as `_client`.
 */
export type Client = {
  get: (opts: Record<string, unknown>) => Promise<{ data?: unknown; error?: unknown }>
  interceptors?: {
    request?: { use: (fn: (request: Request) => Request | Promise<Request>) => void }
    response?: { use: (fn: (response: Response) => Response | Promise<Response>) => void }
    error?: { use: (fn: (error: unknown) => unknown) => void }
  }
  readonly [key: string]: unknown
}

export type Config = {
  baseUrl?: string
  fetch?: typeof fetch
  headers?: Record<string, string>
  [key: string]: unknown
}
