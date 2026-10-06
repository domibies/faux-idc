import { decodeJwt } from 'jose'
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { startServer } from './server.js'

// Starts the real server with an inline config and talks to it over HTTP.
const CONFIG_YAML = `
passwords: [pw]
claimSets:
  default: { claims: { kind: default } }
  shop-customer: { scopes: [pack:shop], claims: { kind: customer } }
  shop-staff: { scopes: [pack:shop], claims: { kind: staff } }
`

let base = ''

before(async () => { base = await startServer(CONFIG_YAML) })

const authorizeQuery = (scope: string) =>
  new URLSearchParams({ response_type: 'code', client_id: 'app', redirect_uri: 'http://app/cb', scope }).toString()

const offeredSets = (html: string) => [...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1])

const tokenRequest = (fields: Record<string, string>) =>
  fetch(`${base}/token`, { method: 'POST', body: new URLSearchParams({ client_id: 'cli', password: 'pw', username: 'u', ...fields }) })

describe('sign-in form', () => {
  test('offers only the claim sets of the requested pack scope', async () => {
    const res = await fetch(`${base}/authorize?${authorizeQuery('openid pack:shop')}`)
    assert.equal(res.status, 200)
    assert.deepEqual(offeredSets(await res.text()), ['shop-customer', 'shop-staff'])
  })

  test('offers only untagged claim sets without a pack scope', async () => {
    const res = await fetch(`${base}/authorize?${authorizeQuery('openid')}`)
    assert.deepEqual(offeredSets(await res.text()), ['default'])
  })

  test('rejects a posted claim set that the pack scope does not allow', async () => {
    const res = await fetch(`${base}/authorize`, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({
        response_type: 'code', client_id: 'app', redirect_uri: 'http://app/cb', scope: 'openid pack:shop',
        username: 'u', claim_set: 'default', password: 'pw',
      }),
    })
    assert.equal(res.status, 401)
    assert.match(await res.text(), /Claim set &quot;default&quot; is not available for scope &quot;openid pack:shop&quot;/)
  })
})

describe('password grant', () => {
  test('uses the first claim set of the pack scope when claim_set is missing', async () => {
    const body = await (await tokenRequest({ grant_type: 'password', scope: 'openid pack:shop' })).json()
    assert.equal(decodeJwt(body.access_token).claim_set, 'shop-customer')
  })

  test('rejects a claim set that the pack scope does not allow', async () => {
    const res = await tokenRequest({ grant_type: 'password', scope: 'openid pack:shop', claim_set: 'default' })
    assert.equal(res.status, 400)
    assert.equal((await res.json()).error, 'invalid_request')
  })
})

describe('discovery', () => {
  test('lists the pack scopes in scopes_supported', async () => {
    const doc = await (await fetch(`${base}/.well-known/openid-configuration`)).json()
    assert.ok(doc.scopes_supported.includes('pack:shop'))
  })

  test('does not list client_credentials without a confidential client', async () => {
    const doc = await (await fetch(`${base}/.well-known/openid-configuration`)).json()
    assert.ok(!doc.grant_types_supported.includes('client_credentials'))
  })
})
