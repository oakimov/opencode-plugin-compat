/** Keep each session's cacheable catalog prefix stable as tools appear/disappear. */
export function createToolCatalogOrder<T extends { name: string }>() {
  const epochs = new Map<string, readonly T[]>()
  const sorted = (tools: readonly T[]) => [...tools].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  return (tools: readonly T[] | undefined, sessionID?: string): T[] | undefined => {
    if (!tools) return undefined
    if (!sessionID || tools.length === 0) return sorted(tools)
    const active = new Set(tools.map(tool => tool.name))
    if (active.size !== tools.length) return sorted(tools)
    const previous = epochs.get(sessionID) ?? []
    const known = new Set(previous.map(tool => tool.name))
    const epoch = [...previous, ...sorted(tools.filter(tool => !known.has(tool.name))).map(tool => structuredClone(tool))]
    epochs.delete(sessionID)
    epochs.set(sessionID, epoch)
    while (epochs.size > 256) epochs.delete(epochs.keys().next().value!)
    return epoch.filter(tool => active.has(tool.name))
  }
}
