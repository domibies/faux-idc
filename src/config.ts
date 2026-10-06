import { readFileSync, statSync } from 'node:fs'
import { parse } from 'yaml'
import { scopeList } from './util.js'

export interface ClaimSet {
  description?: string
  /** Scopes that select this claim set (e.g. a pack scope). Empty = offered when no such scope is requested. */
  scopes: string[]
  claims: Record<string, unknown>
}

export interface Client {
  clientId: string
  clientSecret?: string
  /** Exact URIs, or a prefix ending in `*` (e.g. http://localhost:5173/*). Empty = allow any. */
  redirectUris?: string[]
  /** Default claim set for client_credentials tokens. */
  claimSet?: string
  /** Scopes this client owns: only the clients that list a scope may request it. */
  scopes: string[]
}

/**
 * How the gate authenticates to Entra: a client secret, or a client assertion that the app registration
 * trusts through a federated identity credential.
 */
export type EntraCredential =
  | { type: 'secret'; secret: string }
  /** A token of this user-assigned managed identity, from the local identity endpoint. */
  | { type: 'managed-identity'; managedIdentityClientId: string }
  /** A token read from a file, e.g. a Kubernetes service account token (workload identity). */
  | { type: 'token-file'; federatedTokenFile: string }

export interface EntraConfig {
  tenantId: string
  clientId: string
  credential: EntraCredential
  /** Login host, e.g. https://login.microsoftonline.us for sovereign clouds. */
  authorityHost: string
  /** Who may pass the gate. Empty lists = anyone who can sign in to the app registration. */
  allowedUsers: string[]
  allowedGroups: string[]
  allowedRoles: string[]
  /** Seconds the Entra verification is remembered before asking Microsoft again. */
  sessionTtl: number
  /** Keep grant_type=password (global passwords) working while the gate is on. */
  allowPasswordGrant: boolean
}

export interface Config {
  issuer?: string
  /** Present only when the Entra gate is enabled. */
  entra?: EntraConfig
  passwords: string[]
  claimSets: Record<string, ClaimSet>
  clients: Client[]
  accessTokenTtl: number
  idTokenTtl: number
  refreshTokenTtl: number
  accessTokenAudience?: string | string[]
}

const CONFIG_PATH = process.env.CONFIG_PATH ?? '/config/config.yaml'

const DEFAULTS: Config = {
  passwords: ['password'],
  claimSets: {
    default: {
      description: 'Built-in default',
      scopes: [],
      claims: { name: '{{username}}', email: '{{username}}@example.com' },
    },
  },
  clients: [],
  accessTokenTtl: 3600,
  idTokenTtl: 3600,
  refreshTokenTtl: 86400,
}

let current: Config | undefined
let loadedMtime = -1

function positiveInt(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`\`${name}\` must be a positive integer (seconds)`)
  return n
}

const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])

function normalize(raw: any): Config {
  if (!raw || typeof raw !== 'object') throw new Error('config root must be a map')

  const passwords = (raw.passwords ?? (raw.entra?.enabled ? [] : DEFAULTS.passwords)) as unknown[]
  if (!Array.isArray(passwords)) throw new Error('`passwords` must be a list')

  const rawSets = raw.claimSets ?? DEFAULTS.claimSets
  if (!rawSets || typeof rawSets !== 'object' || Object.keys(rawSets).length === 0) {
    throw new Error('`claimSets` must be a non-empty map')
  }
  const claimSets: Record<string, ClaimSet> = {}
  for (const [name, set] of Object.entries<any>(rawSets)) {
    const claims = set?.claims ?? {}
    if (typeof claims !== 'object' || Array.isArray(claims)) throw new Error(`claimSets.${name}.claims must be a map`)
    if (set?.scopes !== undefined && !Array.isArray(set.scopes)) throw new Error(`claimSets.${name}.scopes must be a list`)
    claimSets[name] = { description: set?.description ? String(set.description) : undefined, scopes: list(set?.scopes), claims }
  }

  const clients: Client[] = []
  for (const cl of (raw.clients ?? []) as any[]) {
    if (!cl?.clientId) throw new Error('every entry in `clients` needs a clientId')
    if (cl.claimSet !== undefined && !claimSets[cl.claimSet]) throw new Error(`clients[${cl.clientId}].claimSet "${cl.claimSet}" is not a claim set`)
    if (cl.scopes !== undefined && !Array.isArray(cl.scopes)) throw new Error(`clients[${cl.clientId}].scopes must be a list`)
    clients.push({
      clientId: String(cl.clientId),
      clientSecret: cl.clientSecret !== undefined ? String(cl.clientSecret) : undefined,
      redirectUris: list(cl.redirectUris),
      claimSet: cl.claimSet !== undefined ? String(cl.claimSet) : undefined,
      scopes: list(cl.scopes),
    })
  }

  return {
    issuer: raw.issuer ? String(raw.issuer) : undefined,
    passwords: passwords.map(String),
    claimSets,
    clients,
    accessTokenTtl: positiveInt(raw.accessTokenTtl, DEFAULTS.accessTokenTtl, 'accessTokenTtl'),
    idTokenTtl: positiveInt(raw.idTokenTtl, DEFAULTS.idTokenTtl, 'idTokenTtl'),
    refreshTokenTtl: positiveInt(raw.refreshTokenTtl, DEFAULTS.refreshTokenTtl, 'refreshTokenTtl'),
    accessTokenAudience: raw.accessTokenAudience,
    entra: resolveEntra(raw.entra && typeof raw.entra === 'object' ? raw.entra : undefined),
  }
}

/** Resolves the Entra section: file values first, ENTRA_* environment variables fill the gaps. */
function resolveEntra(raw: any): EntraConfig | undefined {
  const env = process.env
  const enabled = env.ENTRA_ENABLED ? env.ENTRA_ENABLED === 'true' : raw?.enabled === true
  if (!enabled) return undefined
  const value = (key: string, envName: string) => String(raw?.[key] ?? env[envName] ?? '')
  const required = (key: string, envName: string, when = 'the Entra gate is enabled') => {
    const v = value(key, envName)
    if (!v) throw new Error(`entra.${key} is required when ${when} (or set ${envName})`)
    return v
  }
  return {
    tenantId: required('tenantId', 'ENTRA_TENANT_ID'),
    clientId: required('clientId', 'ENTRA_CLIENT_ID'),
    credential: resolveCredential(value, required),
    authorityHost: String(raw?.authorityHost ?? env.ENTRA_AUTHORITY_HOST ?? 'https://login.microsoftonline.com').replace(/\/+$/, ''),
    allowedUsers: list(raw?.allowedUsers).map((u) => u.toLowerCase()),
    allowedGroups: list(raw?.allowedGroups),
    allowedRoles: list(raw?.allowedRoles),
    sessionTtl: positiveInt(raw?.sessionTtl, 8 * 3600, 'entra.sessionTtl'),
    allowPasswordGrant: raw?.allowPasswordGrant === true,
  }
}

/** Exactly one credential: a client secret, or a client assertion with the settings that its type needs. */
function resolveCredential(
  value: (key: string, envName: string) => string,
  required: (key: string, envName: string, when: string) => string,
): EntraCredential {
  const secret = value('clientSecret', 'ENTRA_CLIENT_SECRET')
  const assertion = value('clientAssertion', 'ENTRA_CLIENT_ASSERTION')
  if (secret && assertion) {
    throw new Error('entra.clientSecret and entra.clientAssertion are mutually exclusive (check ENTRA_CLIENT_SECRET and ENTRA_CLIENT_ASSERTION)')
  }
  if (secret) return { type: 'secret', secret }
  const when = `entra.clientAssertion is ${assertion}`
  switch (assertion) {
    case 'managed-identity':
      return { type: 'managed-identity', managedIdentityClientId: required('managedIdentityClientId', 'ENTRA_MANAGED_IDENTITY_CLIENT_ID', when) }
    case 'token-file':
      return { type: 'token-file', federatedTokenFile: required('federatedTokenFile', 'AZURE_FEDERATED_TOKEN_FILE', when) }
    case '':
      throw new Error('entra.clientSecret or entra.clientAssertion is required when the Entra gate is enabled (or set ENTRA_CLIENT_SECRET or ENTRA_CLIENT_ASSERTION)')
    default:
      throw new Error(`entra.clientAssertion must be managed-identity or token-file, not "${assertion}"`)
  }
}

/** Environment variables always win over the file, so containers can be tweaked without editing it. */
function applyEnv(cfg: Config): Config {
  const out = { ...cfg }
  out.issuer = (process.env.ISSUER || cfg.issuer)?.replace(/\/+$/, '')
  if (process.env.PASSWORDS) out.passwords = process.env.PASSWORDS.split(',').map((p) => p.trim()).filter(Boolean)
  if (!out.entra && out.passwords.length === 0) throw new Error('`passwords` must be a non-empty list (or enable the Entra gate)')
  return out
}

function describe(cfg: Config) {
  return `${Object.keys(cfg.claimSets).length} claim set(s) [${Object.keys(cfg.claimSets).join(', ')}], ` +
    `${cfg.passwords.length} password(s), ${cfg.clients.length || 'any'} client(s)` +
    (cfg.entra ? `, Entra gate ON (tenant ${cfg.entra.tenantId}, ${cfg.entra.credential.type})` : '')
}

/** Validates a parsed config file and applies the environment variables. */
export const parseConfig = (raw: unknown): Config => applyEnv(normalize(raw))

/**
 * The names of the claim sets that a request with this scope may use. Claim sets whose scopes match a
 * requested scope win; without a match, only the claim sets that have no scopes are offered.
 */
export function claimSetsFor(cfg: Config, scope: string | undefined): string[] {
  const requested = new Set(scopeList(scope))
  const sets = Object.entries(cfg.claimSets)
  const matching = sets.filter(([, set]) => set.scopes.some((s) => requested.has(s)))
  return (matching.length ? matching : sets.filter(([, set]) => set.scopes.length === 0)).map(([name]) => name)
}

/**
 * Why this client may not request this scope, or undefined when it may. A scope that a client lists in
 * its `scopes` is restricted to the clients that list it; a scope that no client lists is free.
 */
export function scopeError(cfg: Config, clientId: string, scope: string | undefined): string | undefined {
  const owned = scopeList(scope).find((s) => cfg.clients.some((cl) => cl.scopes.includes(s)) &&
    !cfg.clients.some((cl) => cl.clientId === clientId && cl.scopes.includes(s)))
  return owned && `Client "${clientId}" may not request scope "${owned}"`
}

/** The claim set a request gets: `requested` if the scope allows it, else the first allowed one. */
export function resolveClaimSet(cfg: Config, scope: string | undefined, requested?: string): { claimSet: string } | { error: string } {
  const allowed = claimSetsFor(cfg, scope)
  const claimSet = requested ?? allowed[0]
  if (claimSet !== undefined && allowed.includes(claimSet)) return { claimSet }
  return {
    error: claimSet === undefined
      ? `No claim set is available for scope "${scope ?? ''}"`
      : `Claim set "${claimSet}" is not available for scope "${scope ?? ''}"`,
  }
}

function load(raw: unknown, source: string) {
  current = parseConfig(raw)
  console.log(`[config] loaded ${source}: ${describe(current)}`)
}

/**
 * Returns the active config. The file is re-read whenever its mtime changes, so edits
 * (over ssh, a bind mount, a ConfigMap…) apply immediately without a restart.
 * A broken file is reported and the last good config stays active.
 */
export function getConfig(): Config {
  try {
    const stat = statSync(CONFIG_PATH, { throwIfNoEntry: false })
    if (stat) {
      if (stat.mtimeMs !== loadedMtime) {
        loadedMtime = stat.mtimeMs
        load(parse(readFileSync(CONFIG_PATH, 'utf8')), CONFIG_PATH)
      }
    } else if (!current) {
      if (process.env.CONFIG_YAML) {
        load(parse(process.env.CONFIG_YAML), 'from CONFIG_YAML')
      } else {
        current = parseConfig({})
        console.warn(`[config] ${CONFIG_PATH} not found, using built-in defaults: ${describe(current)}`)
      }
    }
  } catch (err) {
    // Fail closed on startup: never fall back to defaults (and possibly no Entra gate) silently.
    if (!current) throw new Error(`[config] invalid configuration: ${(err as Error).message}`)
    console.error(`[config] failed to load config: ${(err as Error).message} (keeping previous config)`)
  }
  return current!
}
