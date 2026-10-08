import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { parseConfig } from '../src/config.js'
import { startServer } from './server.js'

// One client with a display name, as an Entra app registration has, and one without.
const CONFIG_YAML = `
passwords: [pw]
clients:
  - { clientId: 3f2a9c1e-spa, name: "Bo <Portal>" }
  - { clientId: bo-backend }
`

let base = ''
before(async () => { base = await startServer(CONFIG_YAML) })

async function loginPage(clientId: string): Promise<string> {
  const params = { response_type: 'code', client_id: clientId, redirect_uri: 'http://bo/cb', scope: 'openid', state: 'st' }
  const res = await fetch(`${base}/authorize?${new URLSearchParams(params)}`)
  assert.equal(res.status, 200)
  return res.text()
}

describe('the sign-in form', () => {
  test('shows the name of a client that has one', async () => {
    const page = await loginPage('3f2a9c1e-spa')
    assert.match(page, /Continue to <strong>Bo &lt;Portal&gt;<\/strong>/)
    assert.doesNotMatch(page, /Continue to <code>/)
  })

  test('shows the client_id of a client without a name', async () => {
    assert.match(await loginPage('bo-backend'), /Continue to <code>bo-backend<\/code>/)
  })
})

describe('the name in the config', () => {
  test('is optional', () => {
    assert.equal(parseConfig({ clients: [{ clientId: 'a' }] }).clients[0].name, undefined)
  })

  test('is read as a string', () => {
    assert.equal(parseConfig({ clients: [{ clientId: 'a', name: 'App A' }] }).clients[0].name, 'App A')
  })

  test('must be a string', () => {
    assert.throws(() => parseConfig({ clients: [{ clientId: 'a', name: ['x'] }] }), /clients\[a\]\.name must be a string/)
  })
})
