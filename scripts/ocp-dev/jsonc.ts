export class JsoncError extends Error {
  constructor(message: string, readonly offset?: number) {
    super(offset === undefined ? message : `${message} at ${offset}`)
    this.name = "JsoncError"
  }
}

export type JsoncNode =
  | { type: "null"; start: number; end: number; value: null }
  | { type: "boolean"; start: number; end: number; value: boolean }
  | { type: "number"; start: number; end: number; value: number }
  | { type: "string"; start: number; end: number; value: string }
  | { type: "array"; start: number; end: number; elements: JsoncNode[] }
  | { type: "object"; start: number; end: number; properties: JsoncProperty[] }

export type JsoncProperty = {
  key: string
  keyStart: number
  keyEnd: number
  value: JsoncNode
}

export type JsoncPath = Array<string | number>

class Scanner {
  i = 0
  constructor(readonly s: string) {
    if (s.charCodeAt(0) === 0xfeff) this.i = 1
  }

  eof(): boolean {
    return this.i >= this.s.length
  }

  peek(): string {
    return this.s[this.i] ?? ""
  }

  peekAt(n: number): string {
    return this.s[this.i + n] ?? ""
  }

  skipTrivia(): void {
    while (!this.eof()) {
      const c = this.peek()
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        this.i += 1
        continue
      }
      if (c === "/" && this.peekAt(1) === "/") {
        this.i += 2
        while (!this.eof() && this.peek() !== "\n") this.i += 1
        continue
      }
      if (c === "/" && this.peekAt(1) === "*") {
        const start = this.i
        this.i += 2
        while (!this.eof() && !(this.peek() === "*" && this.peekAt(1) === "/")) this.i += 1
        if (this.eof()) throw new JsoncError("unterminated block comment", start)
        this.i += 2
        continue
      }
      break
    }
  }

  expect(ch: string): void {
    this.skipTrivia()
    if (this.peek() !== ch) throw new JsoncError(`expected '${ch}'`, this.i)
    this.i += 1
  }
}

function hexValue(ch: string): number {
  const c = ch.charCodeAt(0)
  if (c >= 48 && c <= 57) return c - 48
  if (c >= 65 && c <= 70) return c - 55
  if (c >= 97 && c <= 102) return c - 87
  return -1
}

function parseString(s: Scanner): { start: number; end: number; value: string } {
  const start = s.i
  if (s.peek() !== "\"") throw new JsoncError("expected string", s.i)
  s.i += 1
  let value = ""
  while (!s.eof()) {
    const c = s.peek()
    if (c === "\"") {
      s.i += 1
      return { start, end: s.i, value }
    }
    if (c === "\\") {
      s.i += 1
      const e = s.peek()
      s.i += 1
      switch (e) {
        case "\"":
        case "\\":
        case "/":
          value += e
          break
        case "b":
          value += "\b"
          break
        case "f":
          value += "\f"
          break
        case "n":
          value += "\n"
          break
        case "r":
          value += "\r"
          break
        case "t":
          value += "\t"
          break
        case "u": {
          let code = 0
          for (let n = 0; n < 4; n += 1) {
            const h = hexValue(s.peek())
            if (h < 0) throw new JsoncError("invalid unicode escape", s.i)
            code = (code << 4) + h
            s.i += 1
          }
          value += String.fromCharCode(code)
          break
        }
        default:
          throw new JsoncError("invalid escape", s.i - 1)
      }
      continue
    }
    if (c.charCodeAt(0) < 0x20) throw new JsoncError("unescaped control character", s.i)
    value += c
    s.i += 1
  }
  throw new JsoncError("unterminated string", start)
}

function parseNumber(s: Scanner): { start: number; end: number; value: number } {
  const start = s.i
  if (s.peek() === "-") s.i += 1
  if (s.peek() === "0") {
    s.i += 1
  } else if (s.peek() >= "1" && s.peek() <= "9") {
    while (s.peek() >= "0" && s.peek() <= "9") s.i += 1
  } else {
    throw new JsoncError("invalid number", start)
  }
  if (s.peek() === ".") {
    s.i += 1
    if (!(s.peek() >= "0" && s.peek() <= "9")) throw new JsoncError("invalid number", start)
    while (s.peek() >= "0" && s.peek() <= "9") s.i += 1
  }
  const exp = s.peek()
  if (exp === "e" || exp === "E") {
    s.i += 1
    if (s.peek() === "+" || s.peek() === "-") s.i += 1
    if (!(s.peek() >= "0" && s.peek() <= "9")) throw new JsoncError("invalid number", start)
    while (s.peek() >= "0" && s.peek() <= "9") s.i += 1
  }
  const raw = s.s.slice(start, s.i)
  return { start, end: s.i, value: Number(raw) }
}

function parseLiteral(s: Scanner, word: string, value: null | boolean): JsoncNode {
  const start = s.i
  for (let n = 0; n < word.length; n += 1) {
    if (s.peek() !== word[n]) throw new JsoncError(`expected ${word}`, start)
    s.i += 1
  }
  return { type: value === null ? "null" : "boolean", start, end: s.i, value } as JsoncNode
}

function parseArray(s: Scanner): JsoncNode {
  const start = s.i
  s.i += 1
  const elements: JsoncNode[] = []
  s.skipTrivia()
  if (s.peek() === "]") {
    s.i += 1
    return { type: "array", start, end: s.i, elements }
  }
  while (true) {
    elements.push(parseValue(s))
    s.skipTrivia()
    if (s.peek() === ",") {
      s.i += 1
      s.skipTrivia()
      if (s.peek() === "]") {
        s.i += 1
        return { type: "array", start, end: s.i, elements }
      }
      continue
    }
    if (s.peek() === "]") {
      s.i += 1
      return { type: "array", start, end: s.i, elements }
    }
    throw new JsoncError("expected ',' or ']'", s.i)
  }
}

function parseObject(s: Scanner): JsoncNode {
  const start = s.i
  s.i += 1
  const properties: JsoncProperty[] = []
  s.skipTrivia()
  if (s.peek() === "}") {
    s.i += 1
    return { type: "object", start, end: s.i, properties }
  }
  while (true) {
    s.skipTrivia()
    if (s.peek() !== "\"") throw new JsoncError("expected property name", s.i)
    const key = parseString(s)
    s.expect(":")
    const value = parseValue(s)
    properties.push({ key: key.value, keyStart: key.start, keyEnd: key.end, value })
    s.skipTrivia()
    if (s.peek() === ",") {
      s.i += 1
      s.skipTrivia()
      if (s.peek() === "}") {
        s.i += 1
        return { type: "object", start, end: s.i, properties }
      }
      continue
    }
    if (s.peek() === "}") {
      s.i += 1
      return { type: "object", start, end: s.i, properties }
    }
    throw new JsoncError("expected ',' or '}'", s.i)
  }
}

function parseValue(s: Scanner): JsoncNode {
  s.skipTrivia()
  const c = s.peek()
  if (c === "{") return parseObject(s)
  if (c === "[") return parseArray(s)
  if (c === "\"") {
    const str = parseString(s)
    return { type: "string", start: str.start, end: str.end, value: str.value }
  }
  if (c === "-" || (c >= "0" && c <= "9")) {
    const num = parseNumber(s)
    return { type: "number", start: num.start, end: num.end, value: num.value }
  }
  if (c === "t") return parseLiteral(s, "true", true)
  if (c === "f") return parseLiteral(s, "false", false)
  if (c === "n") return parseLiteral(s, "null", null)
  throw new JsoncError("expected value", s.i)
}

export function parseJsonc(text: string): JsoncNode {
  const s = new Scanner(text)
  s.skipTrivia()
  if (s.eof()) return { type: "object", start: 0, end: text.length, properties: [] }
  const value = parseValue(s)
  s.skipTrivia()
  if (!s.eof()) throw new JsoncError("unexpected trailing input", s.i)
  return value
}

export function toValue(node: JsoncNode): unknown {
  switch (node.type) {
    case "array":
      return node.elements.map(toValue)
    case "object": {
      const out: Record<string, unknown> = {}
      for (const prop of node.properties) out[prop.key] = toValue(prop.value)
      return out
    }
    default:
      return node.value
  }
}

export function getNode(root: JsoncNode, path: JsoncPath): JsoncNode | undefined {
  let current: JsoncNode = root
  for (const segment of path) {
    if (typeof segment === "number") {
      if (current.type !== "array") return undefined
      const next = current.elements[segment]
      if (!next) return undefined
      current = next
      continue
    }
    if (current.type !== "object") return undefined
    const prop = current.properties.find((item) => item.key === segment)
    if (!prop) return undefined
    current = prop.value
  }
  return current
}

function detectUnitIndent(text: string): string {
  let i = 0
  while (i < text.length) {
    if (text[i] === "\n") {
      let spaces = ""
      let j = i + 1
      while (j < text.length && (text[j] === " " || text[j] === "\t")) {
        spaces += text[j]
        j += 1
      }
      if (spaces.length > 0 && text[j] === "\"") return spaces
    }
    i += 1
  }
  return "  "
}

function lineIndentAt(text: string, offset: number): string {
  let i = offset
  while (i > 0 && text[i - 1] !== "\n") i -= 1
  let spaces = ""
  while (i < offset && (text[i] === " " || text[i] === "\t")) {
    spaces += text[i]
    i += 1
  }
  return spaces
}

function encode(value: unknown, indent: string, depth: number): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]"
    const inner = indent.repeat(depth + 1)
    const close = indent.repeat(depth)
    const items = value.map((item) => `${inner}${encode(item, indent, depth + 1)}`)
    return `[\n${items.join(",\n")}\n${close}]`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return "{}"
    const inner = indent.repeat(depth + 1)
    const close = indent.repeat(depth)
    const items = entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${encode(item, indent, depth + 1)}`)
    return `{\n${items.join(",\n")}\n${close}}`
  }
  throw new JsoncError(`cannot encode ${typeof value}`)
}

function replaceRange(text: string, start: number, end: number, insert: string): string {
  return text.slice(0, start) + insert + text.slice(end)
}

function nestValue(path: JsoncPath, value: unknown): unknown {
  if (path.length === 0) return value
  const [head, ...tail] = path
  if (typeof head === "number") {
    const arr: unknown[] = []
    arr[head] = nestValue(tail, value)
    return arr
  }
  return { [head]: nestValue(tail, value) }
}

function objectDepth(text: string, object: Extract<JsoncNode, { type: "object" }>): number {
  const indent = detectUnitIndent(text)
  if (object.properties[0]) {
    const found = lineIndentAt(text, object.properties[0].keyStart)
    if (indent && found.startsWith(indent)) return Math.max(1, Math.floor(found.length / indent.length))
    return 1
  }
  const found = lineIndentAt(text, object.start)
  if (indent && found.startsWith(indent)) return Math.floor(found.length / indent.length) + 1
  return 1
}

function insertProperty(text: string, object: Extract<JsoncNode, { type: "object" }>, key: string, value: unknown): string {
  const indent = detectUnitIndent(text)
  const depth = objectDepth(text, object)
  const encoded = encode(value, indent, depth)
  const line = `${indent.repeat(depth)}${JSON.stringify(key)}: ${encoded}`
  if (object.properties.length === 0) {
    const inner = text[object.start + 1] === "\n" ? `\n${line}\n${indent.repeat(Math.max(0, depth - 1))}` : `\n${line}\n`
    return replaceRange(text, object.start + 1, object.end - 1, inner)
  }
  const last = object.properties[object.properties.length - 1]!
  return replaceRange(text, last.value.end, last.value.end, `,\n${line}`)
}

function deleteProperty(text: string, object: Extract<JsoncNode, { type: "object" }>, index: number): string {
  const prop = object.properties[index]
  if (!prop) return text
  if (object.properties.length === 1) {
    return replaceRange(text, object.start, object.end, "{}")
  }
  if (index === 0) {
    const next = object.properties[1]!
    return replaceRange(text, prop.keyStart, next.keyStart, "")
  }
  const prev = object.properties[index - 1]!
  return replaceRange(text, prev.value.end, prop.value.end, "")
}

function deleteElement(text: string, array: Extract<JsoncNode, { type: "array" }>, index: number): string {
  const el = array.elements[index]
  if (!el) return text
  if (array.elements.length === 1) return replaceRange(text, array.start, array.end, "[]")
  if (index === 0) {
    const next = array.elements[1]!
    return replaceRange(text, el.start, next.start, "")
  }
  const prev = array.elements[index - 1]!
  return replaceRange(text, prev.end, el.end, "")
}

function pushElement(text: string, array: Extract<JsoncNode, { type: "array" }>, value: unknown): string {
  const indent = detectUnitIndent(text)
  const sample = array.elements[0]
  const itemIndent = sample ? lineIndentAt(text, sample.start) : `${lineIndentAt(text, array.start)}${indent}`
  const depth = indent ? Math.max(1, Math.floor(itemIndent.length / indent.length)) : 1
  const encoded = encode(value, indent, depth)
  if (array.elements.length === 0) {
    return replaceRange(text, array.start, array.end, `[\n${itemIndent}${encoded}\n${lineIndentAt(text, array.start)}]`)
  }
  const last = array.elements[array.elements.length - 1]!
  return replaceRange(text, last.end, last.end, `,\n${itemIndent}${encoded}`)
}

export function setPath(text: string, path: JsoncPath, value: unknown): string {
  if (path.length === 0) throw new JsoncError("cannot replace document root")
  const root = parseJsonc(text)
  if (root.type !== "object" && root.type !== "array") throw new JsoncError("document is not a container")
  const parentPath = path.slice(0, -1)
  const leaf = path[path.length - 1]!
  const parent = parentPath.length === 0 ? root : getNode(root, parentPath)
  if (!parent) {
    if (parentPath.length === 0) throw new JsoncError("missing parent")
    return setPath(text, parentPath, nestValue([leaf], value))
  }
  if (typeof leaf === "number") {
    if (parent.type !== "array") throw new JsoncError("parent is not an array")
    const existing = parent.elements[leaf]
    if (!existing) throw new JsoncError(`array has no index ${leaf}`)
    const indent = detectUnitIndent(text)
    const depth = indent ? Math.max(0, Math.floor(lineIndentAt(text, existing.start).length / indent.length)) : 0
    return replaceRange(text, existing.start, existing.end, encode(value, indent, depth))
  }
  if (parent.type !== "object") throw new JsoncError("parent is not an object")
  const existing = parent.properties.find((prop) => prop.key === leaf)
  if (!existing) return insertProperty(text, parent, leaf, value)
  const indent = detectUnitIndent(text)
  const depth = indent ? Math.max(0, Math.floor(lineIndentAt(text, existing.value.start).length / indent.length)) : 0
  return replaceRange(text, existing.value.start, existing.value.end, encode(value, indent, depth))
}

export function deletePath(text: string, path: JsoncPath): string {
  if (path.length === 0) throw new JsoncError("cannot delete document root")
  const root = parseJsonc(text)
  const parent = path.length === 1 ? root : getNode(root, path.slice(0, -1))
  if (!parent) return text
  const leaf = path[path.length - 1]!
  if (typeof leaf === "number") {
    if (parent.type !== "array") return text
    return deleteElement(text, parent, leaf)
  }
  if (parent.type !== "object") return text
  const index = parent.properties.findIndex((prop) => prop.key === leaf)
  if (index < 0) return text
  return deleteProperty(text, parent, index)
}

export function pushPath(text: string, path: JsoncPath, value: unknown): string {
  const root = parseJsonc(text)
  const node = getNode(root, path)
  if (!node) return setPath(text, path, [value])
  if (node.type !== "array") throw new JsoncError("push target is not an array")
  return pushElement(text, node, value)
}
