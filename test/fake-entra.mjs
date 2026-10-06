// Minimal fake Entra ID for local testing of the gate: node test/fake-entra.mjs, then set
// entra.authorityHost: http://localhost:9000 and tenantId: 11111111-2222-3333-4444-555555555555, clientSecret: gate-secret.
import http from 'node:http'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { SignJWT, exportJWK } from 'jose'
const HOST = 'http://localhost:9000', TID = '11111111-2222-3333-4444-555555555555'
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...(await exportJWK(publicKey)), kid: 'fake1', alg: 'RS256', use: 'sig' }
const codes = new Map()
let user = { name: 'Test User', preferred_username: 'test.user@example.com', oid: 'aaaa-1' }
http.createServer(async (req, res) => {
  const url = new URL(req.url, HOST)
  const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
  if (url.pathname === '/set-user') { user = JSON.parse(url.searchParams.get('u')); return json({ ok: true }) }
  if (url.pathname === `/${TID}/v2.0/.well-known/openid-configuration`) return json({
    issuer: `${HOST}/${TID}/v2.0`, authorization_endpoint: `${HOST}/${TID}/oauth2/v2.0/authorize`,
    token_endpoint: `${HOST}/${TID}/oauth2/v2.0/token`, jwks_uri: `${HOST}/${TID}/discovery/v2.0/keys` })
  if (url.pathname.endsWith('/discovery/v2.0/keys')) return json({ keys: [jwk] })
  if (url.pathname.endsWith('/oauth2/v2.0/authorize')) {
    const q = Object.fromEntries(url.searchParams)
    console.log('[fake-entra] authorize prompt=%s', q.prompt ?? '-')
    const code = randomBytes(8).toString('hex'); codes.set(code, { ...q, user })
    res.writeHead(302, { location: `${q.redirect_uri}?code=${code}&state=${q.state}` }); return res.end()
  }
  if (url.pathname.endsWith('/oauth2/v2.0/token')) {
    let body = ''; for await (const ch of req) body += ch
    const f = Object.fromEntries(new URLSearchParams(body)); const g = codes.get(f.code); codes.delete(f.code)
    if (!g || f.client_secret !== 'gate-secret') return json({ error: 'invalid_grant', error_description: 'bad code or secret' }, 400)
    if (createHash('sha256').update(f.code_verifier).digest('base64url') !== g.code_challenge) return json({ error: 'invalid_grant', error_description: 'pkce' }, 400)
    const id_token = await new SignJWT({ ...g.user, tid: TID, nonce: g.nonce, ver: '2.0' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fake1' }).setIssuer(`${HOST}/${TID}/v2.0`).setSubject('pairwise-sub')
      .setAudience(f.client_id).setIssuedAt().setExpirationTime('1h').sign(privateKey)
    return json({ token_type: 'Bearer', id_token, access_token: 'x' })
  }
  json({ error: 'not found' }, 404)
}).listen(9000, () => console.log('[fake-entra] on :9000'))
