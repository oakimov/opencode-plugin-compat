declare module "@earendil-works/pi-coding-agent" {
  export function getAgentDir(): string
  export function getMarkdownTheme(): unknown
  export function keyHint(keybinding: string, description: string): string
}

declare module "@earendil-works/pi-tui" {
  export const Container: unknown
  export const Markdown: unknown
  export const Text: unknown
}
