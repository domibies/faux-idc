import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { jwtVerify, SignJWT } from 'jose'
import { timingSafeEqual } from 'node:crypto'
import { renderClaims, uuidFrom } from './claims.js'
import { claimSetsFor, getConfig, resolveClaimSet, type Client, type Config } from './config.js'
import {
  clearEntraSession, getEntraSession, handleEntraCallback, initEntra, safeReturnTo, startEntraLogin,
  type EntraIdentity,
} from './entra.js'
import { loadKeys } from './keys.js'
import { authorizePath, ExpiringMap, pkceS256, randomToken, scopeList } from './util.js'
import { homePage, loginPage, messagePage } from './views.js'

const PORT = Number(process.env.PORT ?? 8080)
const keys = await loadKeys()
initEntra(keys)
try {
  getConfig() // load + log config at startup
} catch (err) {
  console.error((err as Error).message)
  process.exit(1)
}

// ---------------------------------------------------------------- state (in memory)

interface Session {
  username: string; claimSet: string; scope: string; authTime: number; nonce?: string
  /** The real Entra user who passed the gate, if the gate is on. */
  entra?: EntraIdentity
}
interface AuthCode {
  session: Session; clientId: string; redirectUri: string; codeChallenge?: string; codeChallengeMethod?: string
}
interface RefreshGrant { session: Session; clientId: string }

const codes = new ExpiringMap<AuthCode>()
const refreshTokens = new ExpiringMap<RefreshGrant>()

const now = () => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------- helpers

const AUTH_PARAMS = [
  'response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'nonce',
  'code_challenge', 'code_challenge_method', 'prompt', 'login_hint',
] as const
type AuthParams = Partial<Record<(typeof AUTH_PARAMS)[number], string>>

const DEFAULT_SCOPE = 'openid'

const pickAuthParams = (src: Record<string, string>): AuthParams => ({
  scope: DEFAULT_SCOPE,
  ...Object.fromEntries(AUTH_PARAMS.filter((k) => src[k] !== undefined && src[k] !== '').map((k) => [k, src[k]])),
})

const formStrings = (body: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string')) as Record<string, string>

function issuerOf(c: Context, cfg: Config): string {
  if (cfg.issuer) return cfg.issuer
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim() ?? url.protocol.slice(0, -1)
  const host = c.req.header('x-forwarded-host')?.split(',')[0].trim() ?? c.req.header('host') ?? url.host
  return `${proto}://${host}`
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

const passwordGrantEnabled = (cfg: Config) => cfg.passwords.length > 0 && (!cfg.entra || cfg.entra.allowPasswordGrant)
const passwordOk = (cfg: Config, pw: string | undefined) => !!pw && cfg.passwords.some((p) => safeEqual(p, pw))

/** With no clients configured, every client_id is accepted as a public client. */
function findClient(cfg: Config, clientId: string | undefined): Client | undefined {
  if (!clientId) return undefined
  if (cfg.clients.length === 0) return { clientId }
  return cfg.clients.find((cl) => cl.clientId === clientId)
}

function redirectAllowed(client: Client, uri: string): boolean {
  if (!client.redirectUris?.length) return true
  return client.redirectUris.some((p) => (p.endsWith('*') ? uri.startsWith(p.slice(0, -1)) : p === uri))
}

function withParams(uri: string, params: Record<string, string | undefined>): string {
  const u = new URL(uri)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v)
  return u.toString()
}

/** Returns why the authorization request is rejected, or undefined when it is valid. */
function validateAuthRequest(cfg: Config, p: AuthParams): string | undefined {
  if (!p.client_id) return 'The request is missing client_id.'
  if (!p.redirect_uri) return 'The request is missing redirect_uri.'
  try { new URL(p.redirect_uri) } catch { return `redirect_uri "${p.redirect_uri}" is not a valid URL.` }
  const client = findClient(cfg, p.client_id)
  if (!client) return `Client "${p.client_id}" is not configured. Add it under clients in config.yaml.`
  if (!redirectAllowed(client, p.redirect_uri)) {
    return `redirect_uri "${p.redirect_uri}" is not allowed for client "${p.client_id}". Add it to its redirectUris.`
  }
  if (!claimSetsFor(cfg, p.scope).length) {
    return `No claim set is available for scope "${p.scope ?? ''}". Add one under claimSets in config.yaml.`
  }
  return undefined
}

/** With the Entra gate on: the verified identity, or a redirect to Microsoft sign-in when there is none yet. */
async function entraGate(c: Context, cfg: Config, returnTo: string): Promise<EntraIdentity | Response | undefined> {
  if (!cfg.entra) return undefined
  return (await getEntraSession(c)) ?? startEntraLogin(c, cfg.entra, issuerOf(c, cfg), returnTo)
}

function clientCredentials(c: Context, form: Record<string, string>) {
  const header = c.req.header('authorization')
  if (header?.toLowerCase().startsWith('basic ')) {
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString()
    const i = decoded.indexOf(':')
    if (i >= 0) {
      const dec = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }
      return { clientId: dec(decoded.slice(0, i)), clientSecret: dec(decoded.slice(i + 1)) }
    }
  }
  return { clientId: form.client_id, clientSecret: form.client_secret }
}

const oauthError = (c: Context, error: string, description: string, status: 400 | 401 = 400) =>
  c.json({ error, error_description: description }, status)

// ---------------------------------------------------------------- tokens

const RESERVED = new Set(['iss', 'aud', 'exp', 'iat', 'nbf', 'jti', 'auth_time', 'nonce', 'azp'])
/** Claims only the access token carries; userinfo leaves them out. */
const ACCESS_TOKEN_ONLY = new Set(['scope', 'client_id', 'claim_set'])

/**
 * The identity claims a user gets for a claim set: exactly what goes into tokens and userinfo.
 * For a client_credentials token, the client_id takes the place of the username.
 */
function effectiveClaims(cfg: Config, username: string, claimSet: string, entra?: EntraIdentity, user = true) {
  const vars = {
    username, claimSet, uuid: uuidFrom(username),
    // The real person behind the mock login (empty when the Entra gate is off).
    entraName: entra?.name ?? '', entraUsername: entra?.username ?? '', entraEmail: entra?.email ?? '', entraOid: entra?.oid ?? '',
  }
  const rendered = renderClaims(cfg.claimSets[claimSet]?.claims ?? {}, vars) as Record<string, unknown>
  const custom = Object.fromEntries(Object.entries(rendered).filter(([k]) => !RESERVED.has(k)))
  const sub = String(custom.sub ?? username)
  return { sub, aud: rendered.aud, profile: { sub, ...(user ? { preferred_username: username } : {}), ...custom } }
}

const signer = (iss: string, sub: string, t: number) => (payload: Record<string, unknown>, aud: string | string[], ttl: number) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: keys.kid, typ: 'JWT' })
    .setIssuer(iss).setSubject(sub).setAudience(aud)
    .setIssuedAt(t).setExpirationTime(t + ttl).setJti(randomToken(16))
    .sign(keys.privateKey)

const accessAudience = (cfg: Config, aud: unknown, clientId: string) => (aud ?? cfg.accessTokenAudience ?? clientId) as string | string[]

async function issueTokens(cfg: Config, iss: string, clientId: string, s: Session) {
  const t = now()
  const { sub, aud, profile } = effectiveClaims(cfg, s.username, s.claimSet, s.entra)
  const sign = signer(iss, sub, t)

  const [accessToken, idToken] = await Promise.all([
    sign({ ...profile, scope: s.scope, client_id: clientId, claim_set: s.claimSet }, accessAudience(cfg, aud, clientId), cfg.accessTokenTtl),
    scopeList(s.scope).includes('openid')
      ? sign({ ...profile, auth_time: s.authTime, azp: clientId, ...(s.nonce ? { nonce: s.nonce } : {}) }, clientId, cfg.idTokenTtl)
      : undefined,
  ])

  // ID tokens issued from a refresh token carry no nonce.
  const refreshToken = randomToken()
  refreshTokens.set(refreshToken, { session: { ...s, nonce: undefined }, clientId }, cfg.refreshTokenTtl)

  return {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: cfg.accessTokenTtl,
    ...(idToken ? { id_token: idToken } : {}),
    refresh_token: refreshToken,
    scope: s.scope,
  }
}

/** A client_credentials token: the client acts for itself, so there is no user, ID token or refresh token. */
async function issueClientToken(cfg: Config, iss: string, clientId: string, claimSet: string, scope: string) {
  const { sub, aud, profile } = effectiveClaims(cfg, clientId, claimSet, undefined, false)
  const accessToken = await signer(iss, sub, now())(
    { ...profile, scope, client_id: clientId, claim_set: claimSet }, accessAudience(cfg, aud, clientId), cfg.accessTokenTtl)
  return { access_token: accessToken, token_type: 'Bearer', expires_in: cfg.accessTokenTtl, scope }
}

// ---------------------------------------------------------------- app

const app = new Hono()
app.use('*', logger())
app.use('*', cors({ origin: (origin) => origin || '*', credentials: true }))

app.get('/healthz', (c) => c.text('ok'))

app.get('/', async (c) => {
  const cfg = getConfig()
  const entra = await entraGate(c, cfg, '/')
  if (entra instanceof Response) return entra
  return c.html(homePage(cfg, issuerOf(c, cfg)))
})

app.get('/.well-known/openid-configuration', (c) => {
  const cfg = getConfig()
  const iss = issuerOf(c, cfg)
  const claimNames = new Set(['sub', 'iss', 'aud', 'exp', 'iat', 'auth_time', 'nonce', 'preferred_username'])
  const scopes = new Set(['openid', 'profile', 'email', 'offline_access'])
  for (const set of Object.values(cfg.claimSets)) {
    Object.keys(set.claims).forEach((k) => claimNames.add(k))
    set.scopes.forEach((s) => scopes.add(s))
  }
  return c.json({
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    userinfo_endpoint: `${iss}/userinfo`,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    end_session_endpoint: `${iss}/logout`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: [
      'authorization_code', 'refresh_token',
      ...(passwordGrantEnabled(cfg) ? ['password'] : []),
      ...(cfg.clients.some((cl) => cl.clientSecret) ? ['client_credentials'] : []),
    ],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    code_challenge_methods_supported: ['S256', 'plain'],
    scopes_supported: [...scopes],
    claims_supported: [...claimNames],
  })
})

// Used by the login page to preview the exact claims for the typed username + selected set.
app.get('/claims-preview', async (c) => {
  const cfg = getConfig()
  const entra = cfg.entra ? await getEntraSession(c) : undefined
  if (cfg.entra && !entra) return c.json({ error: 'not signed in' }, 401)
  const set = c.req.query('claim_set') ?? ''
  if (!cfg.claimSets[set]) return c.json({ error: 'unknown claim set' }, 404)
  return c.json(effectiveClaims(cfg, c.req.query('username')?.trim() || 'username', set, entra).profile)
})

app.on('GET', ['/.well-known/jwks.json', '/jwks'], (c) => c.json({ keys: [keys.publicJwk] }))

app.get('/authorize', async (c) => {
  const cfg = getConfig()
  const p = pickAuthParams(c.req.query())
  const error = validateAuthRequest(cfg, p)
  if (error) return c.html(messagePage('Sign-in request rejected', error), 400)
  if (p.response_type !== 'code') {
    return c.redirect(withParams(p.redirect_uri!, { error: 'unsupported_response_type', state: p.state }))
  }
  if (p.prompt === 'none') {
    return c.redirect(withParams(p.redirect_uri!, { error: 'login_required', state: p.state }))
  }
  const entra = await entraGate(c, cfg, authorizePath(p))
  if (entra instanceof Response) return entra
  return c.html(loginPage({
    cfg,
    params: p,
    username: p.login_hint ?? getCookie(c, 'faux_idc_user') ?? entra?.username ?? '',
    claimSet: getCookie(c, 'faux_idc_claimset'),
    entra,
  }))
})

app.post('/authorize', async (c) => {
  const cfg = getConfig()
  const form = formStrings(await c.req.parseBody())
  const p = pickAuthParams(form)
  const requestError = validateAuthRequest(cfg, p)
  if (requestError) return c.html(messagePage('Sign-in request rejected', requestError), 400)

  const entra = await entraGate(c, cfg, authorizePath(p))
  if (entra instanceof Response) return entra

  const username = (form.username ?? '').trim()
  const claimSet = form.claim_set ?? ''
  const resolved = resolveClaimSet(cfg, p.scope, claimSet)
  let error: string | undefined
  if (!username) error = 'Enter a username.'
  else if ('error' in resolved) error = `${resolved.error}. Pick another one.`
  else if (!entra && !passwordOk(cfg, form.password)) error = 'That password is not one of the configured passwords.'
  if (error) return c.html(loginPage({ cfg, params: p, username, claimSet, error, entra }), 401)
  if (entra) console.log(`[entra] ${entra.username || entra.oid} signed in as "${username}" with claim set "${claimSet}" for client ${p.client_id}`)

  const code = randomToken()
  codes.set(code, {
    session: { username, claimSet, entra, scope: p.scope!, nonce: p.nonce, authTime: now() },
    clientId: p.client_id!,
    redirectUri: p.redirect_uri!,
    codeChallenge: p.code_challenge,
    codeChallengeMethod: p.code_challenge_method,
  }, 120)

  const cookie = { path: '/', httpOnly: true, sameSite: 'Lax' as const, maxAge: 60 * 60 * 24 * 30 }
  setCookie(c, 'faux_idc_user', username, cookie)
  setCookie(c, 'faux_idc_claimset', claimSet, cookie)

  return c.redirect(withParams(p.redirect_uri!, { code, state: p.state, iss: issuerOf(c, cfg) }), 302)
})

app.post('/token', async (c) => {
  const cfg = getConfig()
  const iss = issuerOf(c, cfg)
  const form = formStrings(await c.req.parseBody())
  const { clientId, clientSecret } = clientCredentials(c, form)
  const client = findClient(cfg, clientId)
  if (!client) return oauthError(c, 'invalid_client', clientId ? `Unknown client "${clientId}"` : 'Missing client_id', 401)
  if (client.clientSecret && !(clientSecret && safeEqual(client.clientSecret, clientSecret))) {
    return oauthError(c, 'invalid_client', 'Invalid client secret', 401)
  }
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')

  let session: Session
  switch (form.grant_type) {
    case 'authorization_code': {
      const grant = codes.take(form.code) // single use
      if (!grant) return oauthError(c, 'invalid_grant', 'Code is invalid, expired or already used')
      if (grant.clientId !== client.clientId) return oauthError(c, 'invalid_grant', 'Code was issued to another client')
      if (form.redirect_uri && form.redirect_uri !== grant.redirectUri) return oauthError(c, 'invalid_grant', 'redirect_uri does not match')
      if (grant.codeChallenge) {
        const verifier = form.code_verifier
        if (!verifier) return oauthError(c, 'invalid_grant', 'Missing code_verifier')
        const computed = grant.codeChallengeMethod === 'S256' ? pkceS256(verifier) : verifier
        if (computed !== grant.codeChallenge) return oauthError(c, 'invalid_grant', 'PKCE verification failed')
      }
      session = grant.session
      break
    }

    case 'refresh_token': {
      const grant = refreshTokens.get(form.refresh_token)
      if (!grant || grant.clientId !== client.clientId) return oauthError(c, 'invalid_grant', 'Refresh token is invalid or expired')
      refreshTokens.delete(form.refresh_token!) // rotate
      session = grant.session
      break
    }

    // Handy for scripts and CI: username + global password + optional claim_set, no browser needed.
    case 'password': {
      if (!passwordGrantEnabled(cfg)) {
        return oauthError(c, 'unsupported_grant_type', cfg.entra
          ? 'The password grant is disabled while the Entra gate is on (set entra.allowPasswordGrant: true to allow it)'
          : 'No passwords are configured')
      }
      const username = form.username?.trim()
      const scope = form.scope ?? DEFAULT_SCOPE
      if (!username || !passwordOk(cfg, form.password)) return oauthError(c, 'invalid_grant', 'Invalid username or password')
      const resolved = resolveClaimSet(cfg, scope, form.claim_set)
      if ('error' in resolved) return oauthError(c, 'invalid_request', resolved.error)
      session = { username, claimSet: resolved.claimSet, scope, authTime: now() }
      break
    }

    // Machine to machine: a confidential client gets a token for itself. The Entra gate does not apply,
    // because the client secret already proves who is asking.
    case 'client_credentials': {
      if (!client.clientSecret) {
        return oauthError(c, 'unauthorized_client', `Client "${client.clientId}" has no clientSecret; client_credentials needs a confidential client`)
      }
      const scope = form.scope ?? ''
      const resolved = resolveClaimSet(cfg, scope, form.claim_set ?? client.claimSet)
      if ('error' in resolved) return oauthError(c, 'invalid_scope', resolved.error)
      return c.json(await issueClientToken(cfg, iss, client.clientId, resolved.claimSet, scope))
    }

    default:
      return oauthError(c, 'unsupported_grant_type', `grant_type "${form.grant_type ?? ''}" is not supported`)
  }

  // The config can change between sign-in and token exchange.
  const resolved = resolveClaimSet(cfg, session.scope, session.claimSet)
  if ('error' in resolved) return oauthError(c, 'invalid_grant', resolved.error)
  return c.json(await issueTokens(cfg, iss, client.clientId, session))
})

// ---------------------------------------------------------------- Entra gate

app.get('/entra/callback', async (c) => {
  const cfg = getConfig()
  if (!cfg.entra) return c.html(messagePage('Entra sign-in is off', 'The Entra gate is not enabled in the configuration.'), 404)
  try {
    const result = await handleEntraCallback(c, cfg.entra, issuerOf(c, cfg))
    if ('error' in result) return c.html(messagePage('Microsoft sign-in failed', result.error), 403)
    console.log(`[entra] ${result.identity.username || result.identity.oid} passed the gate`)
    return c.redirect(result.returnTo)
  } catch (err) {
    console.error('[entra] callback error', err)
    return c.html(messagePage('Microsoft sign-in failed', (err as Error).message), 502)
  }
})

/** Forget the Entra session and pick another Microsoft account, then continue the same login. */
app.get('/entra/switch', (c) => {
  const cfg = getConfig()
  clearEntraSession(c)
  const returnTo = safeReturnTo(c.req.query('return'))
  if (!cfg.entra) return c.redirect(returnTo)
  return startEntraLogin(c, cfg.entra, issuerOf(c, cfg), returnTo, 'select_account')
})

app.get('/entra/logout', (c) => {
  clearEntraSession(c)
  return c.html(messagePage('Signed out', 'Your Entra verification for this mock server was cleared. Your Microsoft session itself is unchanged.'))
})

const userinfo = async (c: Context) => {
  const match = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '')
  if (!match) {
    c.header('WWW-Authenticate', 'Bearer error="invalid_request"')
    return c.json({ error: 'invalid_request', error_description: 'Missing bearer token' }, 401)
  }
  try {
    const { payload } = await jwtVerify(match[1], keys.publicKey)
    return c.json(Object.fromEntries(Object.entries(payload).filter(([k]) => !RESERVED.has(k) && !ACCESS_TOKEN_ONLY.has(k))))
  } catch (err) {
    c.header('WWW-Authenticate', 'Bearer error="invalid_token"')
    return c.json({ error: 'invalid_token', error_description: (err as Error).message }, 401)
  }
}
app.on(['GET', 'POST'], '/userinfo', userinfo)

app.get('/logout', (c) => {
  const { post_logout_redirect_uri: target, state } = c.req.query()
  if (target) {
    try { return c.redirect(withParams(target, { state })) } catch { /* fall through */ }
  }
  return c.html(messagePage('Signed out', 'You are signed out of the mock identity provider.'))
})

// ---------------------------------------------------------------- start

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[server] faux-idc listening on :${info.port}`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.close(); process.exit(0) })
}
