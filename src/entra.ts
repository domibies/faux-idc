/**
 * Optional Microsoft Entra ID "gate": before the mock login form is shown, the person must sign in
 * with a real Entra account. That only proves who is *using* the mock; the identity in the issued
 * tokens is still whatever username + claim set they pick on the form.
 */
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { createHash, createSecretKey, type KeyObject } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from 'jose'
import type { EntraConfig } from './config.js'
import type { SigningKeys } from './keys.js'
import { ExpiringMap, pkceS256, randomToken } from './util.js'

export interface EntraIdentity {
  oid: string
  tid: string
  name: string
  username: string // preferred_username (usually the UPN)
  email: string
}

const COOKIE = 'faux_idc_entra'
const SESSION_AUD = 'faux-idc:entra-session'
const SCOPE = 'openid profile email'
const callbackUrl = (baseUrl: string) => `${baseUrl}/entra/callback`

// Session cookies use their own HMAC key, derived from the signing key, so an issued token can never
// double as a session cookie (and sessions survive restarts whenever the signing key is persisted).
let sessionKey: KeyObject
export const initEntra = (k: SigningKeys) => {
  const pem = k.privateKey.export({ type: 'pkcs8', format: 'pem' })
  sessionKey = createSecretKey(createHash('sha256').update('faux-idc:entra-session:').update(pem).digest())
}

// ---------------------------------------------------------------- Entra metadata (cached)

interface Metadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks: ReturnType<typeof createRemoteJWKSet>
  fetchedAt: number
}
const metadataCache = new Map<string, Metadata>()

async function metadata(cfg: EntraConfig): Promise<Metadata> {
  const url = `${cfg.authorityHost}/${encodeURIComponent(cfg.tenantId)}/v2.0/.well-known/openid-configuration`
  const cached = metadataCache.get(url)
  if (cached && Date.now() - cached.fetchedAt < 3600_000) return cached
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load Entra metadata (${res.status}) from ${url}. Check entra.tenantId.`)
  const doc = (await res.json()) as Record<string, string>
  const md: Metadata = {
    issuer: doc.issuer,
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks: createRemoteJWKSet(new URL(doc.jwks_uri)),
    fetchedAt: Date.now(),
  }
  metadataCache.set(url, md)
  return md
}

// ---------------------------------------------------------------- login round trip

interface Pending { returnTo: string; verifier: string; nonce: string }
const pending = new ExpiringMap<Pending>()

/** Only ever return to our own pages, never to an arbitrary URL. */
export const safeReturnTo = (value: string | undefined) =>
  value && /^\/(authorize\?|$)/.test(value) ? value : '/'

export async function startEntraLogin(c: Context, cfg: EntraConfig, baseUrl: string, returnTo: string, prompt?: string) {
  const md = await metadata(cfg)
  const state = randomToken()
  const verifier = randomToken(48)
  const nonce = randomToken()
  pending.set(state, { returnTo: safeReturnTo(returnTo), verifier, nonce }, 10 * 60)

  const url = new URL(md.authorization_endpoint)
  url.search = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: callbackUrl(baseUrl),
    response_mode: 'query',
    scope: SCOPE,
    state,
    nonce,
    code_challenge: pkceS256(verifier),
    code_challenge_method: 'S256',
    ...(prompt ? { prompt } : {}),
  }).toString()
  return c.redirect(url.toString())
}

type CallbackResult = { identity: EntraIdentity; returnTo: string } | { error: string }

export async function handleEntraCallback(c: Context, cfg: EntraConfig, baseUrl: string): Promise<CallbackResult> {
  const q = c.req.query()
  const p = pending.take(q.state)
  if (q.error) return { error: `Microsoft returned: ${q.error_description ?? q.error}` }
  if (!p) return { error: 'This sign-in attempt expired or was already used. Start again from your app.' }
  if (!q.code) return { error: 'Microsoft did not return an authorization code.' }

  const md = await metadata(cfg)
  const res = await fetch(md.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      grant_type: 'authorization_code',
      code: q.code,
      redirect_uri: callbackUrl(baseUrl),
      code_verifier: p.verifier,
      scope: SCOPE,
    }),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, string>
  if (!res.ok || !body.id_token) {
    return { error: `Token exchange with Microsoft failed: ${body.error_description ?? body.error ?? res.status}` }
  }

  let claims: JWTPayload & Record<string, unknown>
  try {
    ;({ payload: claims } = await jwtVerify(body.id_token, md.jwks, { audience: cfg.clientId }))
  } catch (err) {
    return { error: `Microsoft ID token was rejected: ${(err as Error).message}` }
  }
  // Multi-tenant metadata uses an issuer template with {tenantid}.
  const expectedIssuer = md.issuer.replace('{tenantid}', String(claims.tid ?? ''))
  if (claims.iss !== expectedIssuer) return { error: `Unexpected token issuer ${claims.iss}` }
  if (claims.nonce !== p.nonce) return { error: 'Nonce mismatch in Microsoft ID token.' }

  const identity: EntraIdentity = {
    oid: String(claims.oid ?? claims.sub ?? ''),
    tid: String(claims.tid ?? ''),
    name: String(claims.name ?? ''),
    username: String(claims.preferred_username ?? claims.upn ?? ''),
    email: String(claims.email ?? claims.preferred_username ?? ''),
  }
  const denied = checkAllowed(cfg, identity, claims)
  if (denied) return { error: denied }

  await setSession(c, identity, cfg.sessionTtl, baseUrl.startsWith('https://'))
  return { identity, returnTo: p.returnTo }
}

function checkAllowed(cfg: EntraConfig, who: EntraIdentity, claims: Record<string, unknown>): string | undefined {
  const { allowedUsers, allowedGroups, allowedRoles } = cfg
  if (!allowedUsers.length && !allowedGroups.length && !allowedRoles.length) return undefined

  const names = [who.username, who.email].filter(Boolean).map((n) => n.toLowerCase())
  const userOk = allowedUsers.some((pattern) =>
    pattern.startsWith('*') ? names.some((n) => n.endsWith(pattern.slice(1))) : names.includes(pattern))
  const groups = Array.isArray(claims.groups) ? claims.groups.map(String) : []
  const roles = Array.isArray(claims.roles) ? claims.roles.map(String) : []
  if (userOk || allowedGroups.some((g) => groups.includes(g)) || allowedRoles.some((r) => roles.includes(r))) return undefined

  const overage = allowedGroups.length && (claims as any)._claim_names?.groups
    ? ' (Your account is in too many groups for Entra to list them in the token; use allowedRoles or allowedUsers instead.)'
    : ''
  return `${who.username || who.oid} is signed in to Microsoft but is not allowed to use this mock server.${overage}`
}

// ---------------------------------------------------------------- session cookie

async function setSession(c: Context, who: EntraIdentity, ttl: number, secure: boolean) {
  const jwt = await new SignJWT({ ...who })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(SESSION_AUD)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(sessionKey)
  setCookie(c, COOKIE, jwt, { path: '/', httpOnly: true, secure, sameSite: 'Lax', maxAge: ttl })
}

export async function getEntraSession(c: Context): Promise<EntraIdentity | undefined> {
  const raw = getCookie(c, COOKIE)
  if (!raw) return undefined
  try {
    const { payload } = await jwtVerify(raw, sessionKey, { audience: SESSION_AUD, algorithms: ['HS256'] })
    return {
      oid: String(payload.oid), tid: String(payload.tid), name: String(payload.name ?? ''),
      username: String(payload.username ?? ''), email: String(payload.email ?? ''),
    }
  } catch {
    return undefined
  }
}

export const clearEntraSession = (c: Context) => deleteCookie(c, COOKIE, { path: '/' })
