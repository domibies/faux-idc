// Minimal fake Entra ID for local testing of the gate: node test/fake-entra.mjs, then set
// entra.authorityHost: http://localhost:9000, tenantId: 11111111-2222-3333-4444-555555555555, and one credential:
//   clientSecret: gate-secret
//   or clientAssertion: managed-identity, managedIdentityClientId: 33333333-3333-3333-3333-333333333333,
//      with IDENTITY_ENDPOINT=http://localhost:9000/msi/token IDENTITY_HEADER=fake-identity-header in the environment
//   or clientAssertion: token-file, federatedTokenFile: <a file with the output of http://localhost:9000/k8s/token>
// PORT=0 picks a free port; the first log line shows it.
import http from 'node:http'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { SignJWT, exportJWK, jwtVerify } from 'jose'
const TID = '11111111-2222-3333-4444-555555555555'
const MI_CLIENT_ID = '33333333-3333-3333-3333-333333333333', MI_PRINCIPAL_ID = '44444444-4444-4444-4444-444444444444'
const IDENTITY_HEADER = 'fake-identity-header', SERVICE_ACCOUNT = 'system:serviceaccount:default:faux-idc'
const EXCHANGE_AUDIENCE = 'api://AzureADTokenExchange'
let HOST = ''
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
// Managed identity and Kubernetes tokens are signed with their own key.
const workloadKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...(await exportJWK(publicKey)), kid: 'fake1', alg: 'RS256', use: 'sig' }
const codes = new Map()
let user = { name: 'Test User', preferred_username: 'test.user@example.com', oid: 'aaaa-1' }
let identityCalls = 0

/** The federated identity credentials of the gate app registration. */
const federated = () => [
  { issuer: `${HOST}/${TID}/v2.0`, subject: MI_PRINCIPAL_ID },
  { issuer: `${HOST}/k8s`, subject: SERVICE_ACCOUNT },
]
const workloadToken = (iss, sub, aud) => new SignJWT({}).setProtectedHeader({ alg: 'RS256' })
  .setIssuer(iss).setSubject(sub).setAudience(aud).setIssuedAt().setExpirationTime('1h').sign(workloadKey.privateKey)

/** A client secret, or a client assertion from a workload that the app registration trusts. Never both. */
async function clientAuthenticated(f) {
  if (f.client_secret !== undefined) return f.client_assertion === undefined && f.client_secret === 'gate-secret'
  if (f.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' || !f.client_assertion) return false
  try {
    const { payload } = await jwtVerify(f.client_assertion, workloadKey.publicKey, { audience: EXCHANGE_AUDIENCE })
    return federated().some((c) => c.issuer === payload.iss && c.subject === payload.sub)
  } catch { return false }
}

const server = http.createServer(async (req, res) => {
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
    if (!(await clientAuthenticated(f))) return json({ error: 'invalid_client', error_description: 'bad client secret or assertion' }, 401)
    if (!g) return json({ error: 'invalid_grant', error_description: 'bad code' }, 400)
    if (createHash('sha256').update(f.code_verifier).digest('base64url') !== g.code_challenge) return json({ error: 'invalid_grant', error_description: 'pkce' }, 400)
    const id_token = await new SignJWT({ ...g.user, tid: TID, nonce: g.nonce, ver: '2.0' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fake1' }).setIssuer(`${HOST}/${TID}/v2.0`).setSubject('pairwise-sub')
      .setAudience(f.client_id).setIssuedAt().setExpirationTime('1h').sign(privateKey)
    return json({ token_type: 'Bearer', id_token, access_token: 'x' })
  }
  // The local identity endpoint of Azure Container Apps / App Service (IDENTITY_ENDPOINT).
  if (url.pathname === '/msi/token') {
    identityCalls++
    const q = Object.fromEntries(url.searchParams)
    if (req.headers['x-identity-header'] !== IDENTITY_HEADER) return json({ error: 'unauthorized', error_description: 'bad X-IDENTITY-HEADER' }, 401)
    if (q['api-version'] !== '2019-08-01' || !q.resource) return json({ error: 'invalid_request', error_description: 'bad api-version or resource' }, 400)
    if (q.client_id !== MI_CLIENT_ID) return json({ error: 'invalid_request', error_description: 'Unable to load the proper Managed Identity.' }, 400)
    const access_token = await workloadToken(`${HOST}/${TID}/v2.0`, MI_PRINCIPAL_ID, q.resource)
    return json({ access_token, expires_on: String(Math.floor(Date.now() / 1000) + 3600), resource: q.resource, token_type: 'Bearer', client_id: MI_CLIENT_ID })
  }
  if (url.pathname === '/msi/calls') return json({ calls: identityCalls })
  // A projected Kubernetes service account token, as AZURE_FEDERATED_TOKEN_FILE holds it. ?sub= picks another account.
  if (url.pathname === '/k8s/token') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    return res.end(await workloadToken(`${HOST}/k8s`, url.searchParams.get('sub') ?? SERVICE_ACCOUNT, EXCHANGE_AUDIENCE))
  }
  json({ error: 'not found' }, 404)
})
server.listen(Number(process.env.PORT ?? 9000), () => {
  const { port } = server.address()
  HOST = `http://localhost:${port}`
  console.log(`[fake-entra] on :${port}`)
})
