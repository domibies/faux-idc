import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { parseConfig } from '../src/config.js'
import { startServer } from './server.js'

// Every client registers its post-logout URIs, as in Entra and OpenIddict.
const CONFIG_YAML = `
passwords: [pw]
clients:
  - { clientId: web, postLogoutRedirectUris: ["http://web/signed-out"] }
  - { clientId: spa, postLogoutRedirectUris: ["http://spa/*"] }
`

// One client without postLogoutRedirectUris: it accepts any URI, as before.
const LEGACY_YAML = `
passwords: [pw]
clients:
  - { clientId: web, postLogoutRedirectUris: ["http://web/signed-out"] }
  - { clientId: legacy }
`

let base = ''
let legacyBase = ''
let openBase = ''
before(async () => {
  ;[base, legacyBase, openBase] = await Promise.all([
    startServer(CONFIG_YAML),
    startServer(LEGACY_YAML),
    startServer('passwords: [pw]\nclients: []'),
  ])
})

const logout = (server: string, params: Record<string, string>) =>
  fetch(`${server}/logout?${new URLSearchParams(params)}`, { redirect: 'manual' })

async function idTokenFor(server: string, clientId: string): Promise<string> {
  const res = await fetch(`${server}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: clientId, username: 'u', password: 'pw', scope: 'openid' }),
  })
  const body = await res.json()
  assert.equal(res.status, 200, JSON.stringify(body))
  return body.id_token
}

function assertRedirect(res: Response, expected: string) {
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('location'), expected)
}

async function assertRejected(res: Response, message: RegExp) {
  assert.equal(res.status, 400)
  assert.equal(res.headers.get('location'), null)
  assert.match(await res.text(), message)
}

describe('a registered post_logout_redirect_uri', () => {
  test('is accepted with client_id', async () => {
    const res = await logout(base, { client_id: 'web', post_logout_redirect_uri: 'http://web/signed-out', state: 'st' })
    assertRedirect(res, 'http://web/signed-out?state=st')
  })

  test('is accepted with id_token_hint', async () => {
    const res = await logout(base, { id_token_hint: await idTokenFor(base, 'web'), post_logout_redirect_uri: 'http://web/signed-out' })
    assertRedirect(res, 'http://web/signed-out')
  })

  test('matches a prefix that ends in *', async () => {
    const res = await logout(base, { client_id: 'spa', post_logout_redirect_uri: 'http://spa/bye' })
    assertRedirect(res, 'http://spa/bye')
  })

  test('is accepted without a client when some client registers it', async () => {
    const res = await logout(base, { post_logout_redirect_uri: 'http://web/signed-out' })
    assertRedirect(res, 'http://web/signed-out')
  })
})

describe('an unregistered post_logout_redirect_uri', () => {
  test('is rejected with client_id', async () => {
    const res = await logout(base, { client_id: 'web', post_logout_redirect_uri: 'https://evil.example/' })
    await assertRejected(res, /post_logout_redirect_uri &quot;https:\/\/evil.example\/&quot; is not allowed for client &quot;web&quot;/)
  })

  test('is rejected when only another client registers it', async () => {
    const res = await logout(base, { client_id: 'web', post_logout_redirect_uri: 'http://spa/bye' })
    await assertRejected(res, /is not allowed for client &quot;web&quot;/)
  })

  test('is rejected with id_token_hint', async () => {
    const res = await logout(base, { id_token_hint: await idTokenFor(base, 'web'), post_logout_redirect_uri: 'http://spa/bye' })
    await assertRejected(res, /is not allowed for client &quot;web&quot;/)
  })

  test('is rejected without a client when no client registers it', async () => {
    const res = await logout(base, { post_logout_redirect_uri: 'https://evil.example/' })
    await assertRejected(res, /is not registered for any client/)
  })
})

describe('a logout request', () => {
  test('with an unknown client_id is rejected', async () => {
    const res = await logout(base, { client_id: 'nobody', post_logout_redirect_uri: 'http://web/signed-out' })
    await assertRejected(res, /Client &quot;nobody&quot; is not configured/)
  })

  test('with an id_token_hint that faux-idc did not sign is rejected', async () => {
    const res = await logout(base, { id_token_hint: 'not.a.token', post_logout_redirect_uri: 'http://web/signed-out' })
    await assertRejected(res, /id_token_hint is not valid/)
  })

  test('with an id_token_hint of another client than client_id is rejected', async () => {
    const res = await logout(base, { client_id: 'spa', id_token_hint: await idTokenFor(base, 'web'), post_logout_redirect_uri: 'http://spa/bye' })
    await assertRejected(res, /id_token_hint was not issued to client &quot;spa&quot;/)
  })

  test('with a post_logout_redirect_uri that is not a URL is rejected', async () => {
    const res = await logout(base, { client_id: 'web', post_logout_redirect_uri: 'nope' })
    await assertRejected(res, /is not a valid URL/)
  })

  test('without post_logout_redirect_uri shows the signed-out page', async () => {
    const res = await logout(base, {})
    assert.equal(res.status, 200)
    assert.match(await res.text(), /You are signed out/)
  })
})

describe('a client without postLogoutRedirectUris', () => {
  test('accepts any post_logout_redirect_uri', async () => {
    const res = await logout(legacyBase, { client_id: 'legacy', post_logout_redirect_uri: 'http://anything/' })
    assertRedirect(res, 'http://anything/')
  })

  test('lets a logout without a client go to any URI', async () => {
    const res = await logout(legacyBase, { post_logout_redirect_uri: 'http://anything/' })
    assertRedirect(res, 'http://anything/')
  })
})

describe('with clients: []', () => {
  test('any post_logout_redirect_uri is accepted', async () => {
    const res = await logout(openBase, { client_id: 'whatever', post_logout_redirect_uri: 'http://anything/' })
    assertRedirect(res, 'http://anything/')
  })
})

describe('client postLogoutRedirectUris', () => {
  test('must be a list', () => {
    assert.throws(
      () => parseConfig({ clients: [{ clientId: 'web', postLogoutRedirectUris: 'http://web/signed-out' }] }),
      /clients\[web\]\.postLogoutRedirectUris must be a list/,
    )
  })
})
