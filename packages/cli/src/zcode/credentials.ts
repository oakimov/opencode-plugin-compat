/**
 * Local bridge credentials: scoped secrets that authorize ZCode's requests to
 * this OCP process. They are unrelated to the consumer plugin's upstream auth
 * and never leave the loopback listener.
 */
import { randomBytes, timingSafeEqual, createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { CredentialRef } from "./config.js"

const MIN_CREDENTIAL_LENGTH = 24

export class CredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CredentialError"
  }
}

/** Resolve a credential reference to its secret value. */
export function resolveCredential(ref: CredentialRef, env: NodeJS.ProcessEnv = process.env): string {
  let value: string | undefined
  if ("env" in ref) {
    value = env[ref.env]
    if (!value) throw new CredentialError(`environment variable ${ref.env} is not set`)
  } else {
    try {
      value = readFileSync(ref.file, "utf8").trim()
    } catch (error) {
      throw new CredentialError(`cannot read credential file ${ref.file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (value.length < MIN_CREDENTIAL_LENGTH) {
    throw new CredentialError(`credential ${describeCredentialRef(ref)} is shorter than ${MIN_CREDENTIAL_LENGTH} characters`)
  }
  return value
}

export function describeCredentialRef(ref: CredentialRef): string {
  return "env" in ref ? `env:${ref.env}` : `file:${ref.file}`
}

export function generateCredential(): string {
  return `ocpz_${randomBytes(32).toString("base64url")}`
}

/** Write a new credential file (0600). Refuses to overwrite an existing one. */
export function writeCredentialFile(file: string, value = generateCredential()): string {
  if (existsSync(file)) throw new CredentialError(`credential file ${file} already exists; remove it first to rotate`)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${value}\n`, { mode: 0o600, flag: "wx" })
  chmodSync(file, 0o600)
  return value
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}

/** Constant-time equality over fixed-length digests. */
export function credentialEquals(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected))
}

export type PresentedCredential =
  | { kind: "none" }
  | { kind: "conflict" }
  | { kind: "one"; value: string }

/**
 * Extract the credential a client presented. ZCode's Anthropic transport sends
 * both `x-api-key` and `Authorization: Bearer` with the same key; any mismatch
 * between them is rejected rather than picking one.
 */
export function presentedCredential(headers: Headers): PresentedCredential {
  const values = new Set<string>()
  const apiKey = headers.get("x-api-key")?.trim()
  if (apiKey) values.add(apiKey)
  const authorization = headers.get("authorization")?.trim()
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization)
    if (!match) return { kind: "conflict" }
    values.add(match[1]!.trim())
  }
  if (values.size === 0) return { kind: "none" }
  if (values.size > 1) return { kind: "conflict" }
  return { kind: "one", value: [...values][0]! }
}
