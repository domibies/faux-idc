import { decodeJwt } from 'jose'
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { parseConfig } from '../src/config.js'
import { startServer } from './server.js'

// The setup of Bo: a public client for people, and a confidential client that owns the ingest scope.
const CONFIG_YAML = `
passwords: [pw]
clients:
  - { clientId: bo }
  - { clientId: bo-ingest, clientSecret: ingest-secret, claimSet: ingest, scopes: [bo.ingest, bo.audit] }
  - { clientId: other, clientSecret: other-secret }
claimSets:
  ingest: { scopes: [bo.ingest], claims: {} }
  employee: { scopes: [pack:boma], claims: { kind: employee } }
`

let base = ''
before(async () => { base = await startServer(CONFIG_YAML) })

const RESTRICTED = 'openid pack:boma bo.ingest'

const authorizeParams = (scope: string) =>
  ({ response_type: 'code', client_id: 'bo', redirect_uri: 'http://bo/cb', scope, state: 'st' })

const tokenRequest = (fields: Record<string, string>) =>
  fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams(fields) })

/** The error parameters of a redirect back to the client. */
function redirectError(res: Response) {
  assert.equal(res.status, 302)
  const location = new URL(res.headers.get('location')!)
  return { origin: location.origin, ...Object.fromEntries(location.searchParams) }
}

describe('a scope that another client owns', () => {
  test('is rejected on the sign-in form with a redirect', async () => {
    const res = await fetch(`${base}/authorize?${new URLSearchParams(authorizeParams(RESTRICTED))}`, { redirect: 'manual' })
    const error = redirectError(res)
    assert.equal(error.origin, 'http://bo')
    assert.equal(error.error, 'invalid_scope')
    assert.equal(error.state, 'st')
    assert.match(error.error_description, /Client "bo" may not request scope "bo.ingest"/)
  })

  test('is rejected when the sign-in form is posted', async () => {
    const res = await fetch(`${base}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ ...authorizeParams(RESTRICTED), username: 'u', claim_set: 'employee', password: 'pw' }),
    })
    assert.equal(redirectError(res).error, 'invalid_scope')
  })

  test('is rejected in the password grant', async () => {
    const res = await tokenRequest({ grant_type: 'password', client_id: 'bo', username: 'u', password: 'pw', scope: RESTRICTED, claim_set: 'employee' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'invalid_scope')
  })

  test('is rejected in the client_credentials grant of another confidential client', async () => {
    const res = await tokenRequest({ grant_type: 'client_credentials', client_id: 'other', client_secret: 'other-secret', scope: 'bo.ingest' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'invalid_scope')
  })
})

describe('the client that owns a scope', () => {
  test('gets the scope with client_credentials', async () => {
    const res = await tokenRequest({ grant_type: 'client_credentials', client_id: 'bo-ingest', client_secret: 'ingest-secret', scope: 'bo.ingest' })
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.equal(decodeJwt(body.access_token).scope, 'bo.ingest')
  })
})

describe('a scope that no client owns', () => {
  test('stays free for every client', async () => {
    const res = await tokenRequest({ grant_type: 'password', client_id: 'bo', username: 'u', password: 'pw', scope: 'openid pack:boma api:read' })
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.equal(decodeJwt(body.access_token).scope, 'openid pack:boma api:read')
  })
})

describe('discovery', () => {
  test('lists the scopes of the clients in scopes_supported', async () => {
    const doc = await (await fetch(`${base}/.well-known/openid-configuration`)).json()
    assert.ok(doc.scopes_supported.includes('bo.audit'))
  })
})

describe('client scopes', () => {
  test('must be a list', () => {
    assert.throws(
      () => parseConfig({ clients: [{ clientId: 'svc', scopes: 'bo.ingest' }] }),
      /clients\[svc\]\.scopes must be a list/,
    )
  })
})
