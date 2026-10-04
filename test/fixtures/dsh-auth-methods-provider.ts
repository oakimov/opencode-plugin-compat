/** Auth hook offering OAuth before an API key, like cursor-opencode-provider. */

export const seenAuth: Array<{ type?: string; key?: string; access?: string }> = []
export const offered: { methods: Array<"oauth" | "api"> } = { methods: ["oauth", "api"] }

export function createDshMethods() {
  return {
    languageModel(modelId: string) {
      return {
        specificationVersion: "v3",
        modelId,
        provider: "dsh-methods",
        async doStream() {
          return { stream: new ReadableStream({ start(controller) { controller.close() } }) }
        },
      }
    },
  }
}

export async function DshMethodsPlugin() {
  return {
    auth: {
      provider: "dsh-methods",
      methods: offered.methods.map(type => ({ type, label: type, async authorize() { return { type: "failed" as const } } })),
      async loader(getAuth: () => Promise<{ type?: string; key?: string; access?: string } | undefined>) {
        const auth = await getAuth()
        if (auth) seenAuth.push({ ...auth })
        return {}
      },
    },
    async config(config: { provider?: Record<string, { models?: Record<string, unknown> }> }) {
      config.provider ??= {}
      config.provider["dsh-methods"] = { models: { "methods-model": { name: "Methods Model" } } }
    },
  }
}

export default DshMethodsPlugin
