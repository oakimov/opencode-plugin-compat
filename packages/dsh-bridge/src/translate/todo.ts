/**
 * DSH `todo_write` ↔ OpenCode / Cursor `todowrite`.
 *
 * Host (`packages/todo/tool-todo/src/index.ts:154-165`) is replace-all
 * `{todos:[{content,status}]}` with `additionalProperties: false` and no
 * `cancelled`. Cursor native TodoWrite / display mirrors always include
 * `id` and `priority` (`mapTodos`). Strip extras on ingress; omit cancelled
 * rows (DSH cancel = drop from the snapshot).
 */

const DSH_TODO_STATUSES = new Set(["pending", "in_progress", "completed"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function hostTodoStatus(value: unknown): "pending" | "in_progress" | "completed" | undefined {
  if (typeof value !== "string") return "pending"
  const status = value.toLowerCase().replace(/^todo_status_/, "")
  if (status === "cancelled" || status === "canceled") return undefined
  if (DSH_TODO_STATUSES.has(status)) return status as "pending" | "in_progress" | "completed"
  return "pending"
}

/** Provider `todowrite` → host `todo_write` (content+status only). */
export function translateToHostTodoInput(input: Record<string, unknown>): Record<string, unknown> {
  const todos = input["todos"]
  if (!Array.isArray(todos)) return input
  const items: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> = []
  const seen = new Set<string>()
  for (const entry of todos) {
    if (!isRecord(entry)) continue
    const content = typeof entry["content"] === "string" ? entry["content"].trim() : ""
    if (!content || seen.has(content)) continue
    const status = hostTodoStatus(entry["status"])
    if (status === undefined) continue
    seen.add(content)
    items.push({ content, status })
  }
  return { todos: items }
}
