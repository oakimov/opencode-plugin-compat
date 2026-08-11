/**
 * A synthetic *unmodified-style* OpenCode plugin package, standing in for an
 * arbitrary third-party provider. It implements only the standard OpenCode
 * conventions — an AI-SDK `createXxx` factory plus a classic plugin factory
 * exposing `auth` (OAuth + API-key methods) and `config` (model catalog) —
 * and nothing bridge-specific.
 *
 * Its whole purpose is to prove the bridge is generic: if this fixture works
 * end to end with zero per-plugin code, so does any real OpenCode plugin
 * following the same conventions.
 */

// ── Convention 1: the AI-SDK provider factory ──
export function createAcme(options: Record<string, unknown> = {}) {
  return {
    options,
    languageModel(modelId: string) {
      return { specificationVersion: "v3", modelId, provider: "acme", options }
    },
  }
}

// ── Convention 2: the classic OpenCode plugin factory (auth + config hooks) ──
export async function AcmePlugin(input: {
  client: { auth: { set(args: unknown): Promise<unknown> } }
  directory: string
}) {
  let pollCount = 0

  return {
    auth: {
      provider: "acme",
      methods: [
        {
          type: "oauth" as const,
          label: "Acme account (browser login)",
          async authorize() {
            return {
              url: "https://acme.example/login?challenge=abc",
              instructions: "Open this URL to sign in to Acme",
              method: "auto",
              async callback() {
                pollCount++
                return {
                  type: "success" as const,
                  provider: "acme",
                  access: "acme-access-token",
                  refresh: "acme-refresh-token",
                  expires: 1_800_000_000_000,
                }
              },
            }
          },
        },
        {
          type: "api" as const,
          label: "API key (acme.example/settings)",
          prompts: [
            {
              type: "text" as const,
              key: "apiKey",
              message: "Acme API key",
              placeholder: "acme_...",
              validate(value: string) {
                return value.startsWith("acme_") ? undefined : "API key should start with acme_"
              },
            },
          ],
          async authorize(inputs?: Record<string, string>) {
            const apiKey = inputs?.apiKey
            if (!apiKey) return { type: "failed" as const }
            return { type: "success" as const, key: `exchanged:${apiKey}`, provider: "acme", metadata: { refreshToken: "acme-refresh-token" } }
          },
        },
      ],
      /** Refresh path: renews and persists back through the host client, exactly as OpenCode plugins do. */
      async loader(getAuth: () => Promise<unknown>) {
        const auth = (await getAuth()) as { type?: string; access?: string; refresh?: string } | undefined
        if (auth?.type === "oauth" && auth.refresh) {
          await input.client.auth.set({
            path: { id: "acme" },
            body: { type: "oauth", access: "acme-access-token-v2", refresh: auth.refresh, expires: 1_900_000_000_000 },
          })
        }
        return { pollCount }
      },
    },

    /** Model catalog, published the standard OpenCode way. */
    async config(config: { provider?: Record<string, unknown> }) {
      config.provider ??= {}
      config.provider.acme = {
        name: "Acme",
        models: {
          "acme-large": {
            name: "Acme Large",
            reasoning: true,
            tool_call: true,
            limit: { context: 200_000, output: 32_000 },
            cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
            modalities: { input: ["text", "image"], output: ["text"] },
          },
          "acme-small": {
            name: "Acme Small",
            reasoning: false,
            limit: { context: 128_000 },
            cost: { input: 0.5, output: 1.5 },
          },
        },
      }
    },
  }
}

export default AcmePlugin
