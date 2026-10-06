import { decodeJwt } from 'jose'
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { parseConfig } from '../src/config.js'
import { startServer } from './server.js'

const CONFIG_YAML = `
passwords: [pw]
clients:
  - { clientId: svc, clientSecret: svc-secret }
  - { clientId: svc-staff, clientSecret: staff-secret, claimSet: shop-staff }
  - { clientId: spa }
claimSets:
  default: { claims: { kind: default, app: "{{username}}" } }
  named: { claims: { kind: named, sub: "service:{{username}}" } }
  shop-customer: { scopes: [pack:shop], claims: { kind: customer } }
  shop-staff: { scopes: [pack:shop], claims: { kind: staff } }
`

let base = ''
before(async () => { base = await startServer(CONFIG_YAML) })

const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`

const tokenRequest = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(`${base}/token`, { method: 'POST', headers, body: new URLSearchParams({ grant_type: 'client_credentials', ...fields }) })

/** A successful client_credentials response and the claims of its access token. */
async function issued(fields: Record<string, string>, headers?: Record<string, string>) {
  const res = await tokenRequest(fields, headers)
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  return { body, claims: decodeJwt(body.access_token) }
}

describe('client_credentials grant', () => {
  test('issues an access token to a client that authenticates with client_secret_basic', async () => {
    const { body, claims } = await issued({ scope: 'api:read' }, { authorization: basic('svc', 'svc-secret') })
    assert.equal(body.token_type, 'Bearer')
    assert.equal(body.scope, 'api:read')
    assert.equal(claims.sub, 'svc')
    assert.equal(claims.aud, 'svc')
    assert.equal(claims.client_id, 'svc')
    assert.equal(claims.scope, 'api:read')
  })

  test('issues an access token to a client that authenticates with client_secret_post', async () => {
    const { claims } = await issued({ client_id: 'svc', client_secret: 'svc-secret' })
    assert.equal(claims.sub, 'svc')
  })

  test('issues no ID token and no refresh token, even for scope openid', async () => {
    const { body } = await issued({ client_id: 'svc', client_secret: 'svc-secret', scope: 'openid offline_access' })
    assert.equal(body.id_token, undefined)
    assert.equal(body.refresh_token, undefined)
  })

  test('renders the claims with the client_id as the username and adds no preferred_username', async () => {
    const { claims } = await issued({ client_id: 'svc', client_secret: 'svc-secret' })
    assert.equal(claims.app, 'svc')
    assert.equal(claims.preferred_username, undefined)
  })

  test('uses the sub of the claim set', async () => {
    const { claims } = await issued({ client_id: 'svc', client_secret: 'svc-secret', claim_set: 'named' })
    assert.equal(claims.sub, 'service:svc')
  })

  test('rejects a wrong client secret', async () => {
    const res = await tokenRequest({}, { authorization: basic('svc', 'wrong') })
    assert.equal(res.status, 401)
    assert.equal((await res.json()).error, 'invalid_client')
  })

  test('rejects a public client', async () => {
    const res = await tokenRequest({ client_id: 'spa' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'unauthorized_client')
  })

  test('gives an unknown scope the claim sets without scopes', async () => {
    const { claims } = await issued({ client_id: 'svc', client_secret: 'svc-secret', scope: 'api:unknown' })
    assert.equal(claims.claim_set, 'default')
  })

  test('uses the first claim set of a pack scope', async () => {
    const { claims } = await issued({ client_id: 'svc', client_secret: 'svc-secret', scope: 'pack:shop' })
    assert.equal(claims.claim_set, 'shop-customer')
  })

  test('uses the claim_set parameter when the scope allows it', async () => {
    const { claims } = await issued({ client_id: 'svc', client_secret: 'svc-secret', scope: 'pack:shop', claim_set: 'shop-staff' })
    assert.equal(claims.claim_set, 'shop-staff')
  })

  test('rejects a claim_set that the scope does not allow', async () => {
    const res = await tokenRequest({ client_id: 'svc', client_secret: 'svc-secret', scope: 'pack:shop', claim_set: 'default' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'invalid_scope')
  })

  test('uses the claim set of the client before the first claim set of the scope', async () => {
    const { claims } = await issued({ client_id: 'svc-staff', client_secret: 'staff-secret', scope: 'pack:shop' })
    assert.equal(claims.claim_set, 'shop-staff')
  })

  test('applies the scope rules to the claim set of the client', async () => {
    const res = await tokenRequest({ client_id: 'svc-staff', client_secret: 'staff-secret', scope: 'api:read' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'invalid_scope')
  })

  test('is listed in discovery when a confidential client exists', async () => {
    const doc = await (await fetch(`${base}/.well-known/openid-configuration`)).json()
    assert.ok(doc.grant_types_supported.includes('client_credentials'))
  })
})

describe('client_credentials grant with the Entra gate on', () => {
  test('issues an access token', async () => {
    const gated = await startServer(CONFIG_YAML, {
      ENTRA_ENABLED: 'true', ENTRA_TENANT_ID: '00000000-0000-0000-0000-000000000000',
      ENTRA_CLIENT_ID: '00000000-0000-0000-0000-000000000000', ENTRA_CLIENT_SECRET: 'not-used',
    })
    const res = await fetch(`${gated}/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'svc', client_secret: 'svc-secret' }),
    })
    assert.equal(res.status, 200)
  })
})

describe('client claimSet', () => {
  test('must name a claim set', () => {
    assert.throws(
      () => parseConfig({ clients: [{ clientId: 'svc', clientSecret: 's', claimSet: 'nope' }] }),
      /clients\[svc\]\.claimSet "nope" is not a claim set/,
    )
  })
})
