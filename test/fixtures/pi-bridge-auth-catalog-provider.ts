/** OpenCode-style provider whose config catalog appears only after auth.loader. */

export function createAuthCatalog(options: Record<string, unknown> = {}) {
  return {
    options,
    languageModel(modelId: string) {
      return { specificationVersion: "v3", modelId, provider: "auth-catalog", options }
    },
  }
}

export async function AuthCatalogPlugin() {
  let authenticated = false

  return {
    auth: {
      provider: "auth-catalog",
      methods: [
        {
          type: "oauth" as const,
          label: "Auth Catalog account",
          async authorize() {
            return {
              url: "https://auth-catalog.example/login",
              async callback() {
                return {
                  type: "success" as const,
                  provider: "auth-catalog",
                  access: "auth-catalog-access",
                  refresh: "auth-catalog-refresh",
                  expires: 1_900_000_000_000,
                }
              },
            }
          },
        },
      ],
      async loader(getAuth: () => Promise<unknown>) {
        const auth = await getAuth() as { access?: string; key?: string } | undefined
        authenticated = Boolean(auth?.access || auth?.key)
        return {}
      },
    },

    async config(config: { provider?: Record<string, unknown> }) {
      config.provider ??= {}
      config.provider["auth-catalog"] = {
        name: "Auth Catalog",
        models: authenticated
          ? {
              "auth-model": {
                name: "Authenticated Model",
                limit: { context: 64_000, output: 8_000 },
              },
            }
          : {},
      }
    },
  }
}

export default AuthCatalogPlugin
