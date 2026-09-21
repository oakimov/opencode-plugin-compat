/** Catalog and factory key appear only after auth.loader sees a credential. */

export const loaderKeys: string[] = []
export const factoryKeys: Array<string | undefined> = []

export function createDshAuth(options: Record<string, unknown> = {}) {
  const apiKey = typeof options.apiKey === "string" ? options.apiKey : undefined
  factoryKeys.push(apiKey)
  return {
    languageModel(modelId: string) {
      return {
        specificationVersion: "v3",
        modelId,
        provider: "dsh-auth",
        async doStream() {
          return {
            stream: new ReadableStream({
              start(controller) {
                controller.close()
              },
            }),
          }
        },
      }
    },
  }
}

export async function DshAuthPlugin() {
  let authenticated = false
  return {
    auth: {
      provider: "dsh-auth",
      methods: [
        {
          type: "api" as const,
          label: "API key",
          async authorize(inputs: Record<string, string>) {
            return { type: "success" as const, key: inputs.key ?? "" }
          },
        },
      ],
      async loader(getAuth: () => Promise<{ key?: string; access?: string } | undefined>) {
        const auth = await getAuth()
        const key = auth?.key ?? auth?.access ?? ""
        loaderKeys.push(key)
        authenticated = key.length > 0
        return {}
      },
    },
    async config(config: { provider?: Record<string, { name?: string; models?: Record<string, unknown> }> }) {
      config.provider ??= {}
      config.provider["dsh-auth"] = {
        name: "DSH Auth",
        models: authenticated
          ? { "auth-model": { name: "Authenticated Model", limit: { context: 8_000, output: 1_000 } } }
          : {},
      }
    },
  }
}

export default DshAuthPlugin
