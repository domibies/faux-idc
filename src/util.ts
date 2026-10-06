import { createHash, randomBytes } from 'node:crypto'

/** The individual scopes of a space-separated `scope` value. */
export const scopeList = (scope: string | undefined) => scope?.split(' ').filter(Boolean) ?? []

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

/** The PKCE S256 code challenge for a code verifier. */
export const pkceS256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

/** The /authorize URL that restarts a sign-in with the given request parameters. */
export const authorizePath = (params: Record<string, string | undefined>) =>
  `/authorize?${new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined))}`

/** A map whose entries expire after a TTL. Expired entries read as missing and are swept every minute. */
export class ExpiringMap<V> {
  private readonly items = new Map<string, { value: V; expiresAt: number }>()

  constructor() {
    setInterval(() => {
      const t = Date.now()
      for (const [k, v] of this.items) if (v.expiresAt < t) this.items.delete(k)
    }, 60_000).unref()
  }

  set(key: string, value: V, ttlSeconds: number) {
    this.items.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  }

  get(key: string | undefined): V | undefined {
    const item = key === undefined ? undefined : this.items.get(key)
    return item && item.expiresAt >= Date.now() ? item.value : undefined
  }

  delete(key: string) {
    this.items.delete(key)
  }

  /** Removes the entry and returns its value if it had not expired. For single-use values. */
  take(key: string | undefined): V | undefined {
    const value = this.get(key)
    if (key !== undefined) this.items.delete(key)
    return value
  }
}
