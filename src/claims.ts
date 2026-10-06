import { createHash } from 'node:crypto'

/** Deterministic UUID derived from a string, so the same username always gets the same id. */
export function uuidFrom(input: string): string {
  // The seed keeps the project's original name so ids stay stable across the rename.
  const h = createHash('sha1').update(`mock-oidc:${input}`).digest('hex')
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Replaces {{username}}, {{claimSet}} and {{uuid}} in every string value, recursively. */
export function renderClaims(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => vars[key] ?? match)
  }
  if (Array.isArray(value)) return value.map((v) => renderClaims(v, vars))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderClaims(v, vars)]))
  }
  return value
}
