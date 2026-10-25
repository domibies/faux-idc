import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, describe, test } from 'node:test'
import { startServer } from './server.js'

const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version as string

// Three claim sets without scopes (radio cards), six with pack:many (dropdown), one hidden.
const CONFIG_YAML = `
passwords: [pw]
clients:
  - { clientId: spa, name: Shop portal }
  - { clientId: job, clientSecret: s, scopes: [api:write] }
claimSets:
  user: { description: Regular user, claims: {} }
  azure-like: { description: Entra style, claims: {} }
  admin: { description: Full access, usernames: [sysop], claims: {} }
${[1, 2, 3, 4, 5, 6].map((n) => `  many-${n}: { scopes: [pack:many], claims: {} }`).join('\n')}
`

let base = ''
before(async () => { base = await startServer(CONFIG_YAML) })

async function loginPage(extra: Record<string, string> = {}) {
  const query = new URLSearchParams({ response_type: 'code', client_id: 'spa', redirect_uri: 'http://app/cb', scope: 'openid', ...extra })
  const res = await fetch(`${base}/authorize?${query}`)
  assert.equal(res.status, 200)
  return res.text()
}

const radios = (page: string) => [...page.matchAll(/<input type="radio" name="claim_set" value="([^"]+)"/g)].map((m) => m[1])

describe('the claim set picker', () => {
  test('shows radio cards for a few claim sets', async () => {
    const page = await loginPage({ login_hint: 'alice' })
    assert.deepEqual(radios(page), ['user', 'azure-like'])
    assert.match(page, /<fieldset class="sets" id="sets"[^>]*>/)
    assert.doesNotMatch(page, /<fieldset class="sets" id="sets"[^>]*disabled/)
    assert.match(page, /<select name="claim_set" id="claim_set"[^>]* disabled hidden>/)
  })

  test('checks the selected claim set', async () => {
    assert.match(await loginPage({ login_hint: 'alice' }), /value="user" checked>/)
  })

  test('adds the hidden claim sets that the username unlocks', async () => {
    assert.deepEqual(radios(await loginPage({ login_hint: 'sysop' })), ['user', 'azure-like', 'admin'])
  })

  test('falls back to the dropdown for more than five claim sets', async () => {
    const page = await loginPage({ scope: 'openid pack:many' })
    assert.match(page, /<fieldset class="sets" id="sets"[^>]* disabled hidden>/)
    assert.doesNotMatch(page, /<select name="claim_set" id="claim_set"[^>]*disabled/)
  })
})

describe('every page', () => {
  test('has a favicon', async () => {
    assert.match(await loginPage(), /<link rel="icon" href="data:image\/svg\+xml,/)
  })

  test('shows the version', async () => {
    assert.ok((await loginPage()).includes(`v${VERSION}`))
  })
})

describe('the home page', () => {
  let page = ''
  before(async () => { page = await (await fetch(`${base}/`)).text() })

  test('shows the version', () => {
    assert.ok(page.includes(`v${VERSION}`))
  })

  test('lists the endpoints of the issuer', () => {
    assert.match(page, new RegExp(`<code class="val">${base}/\\.well-known/openid-configuration</code>`))
    assert.match(page, new RegExp(`<code class="val">${base}/token</code>`))
  })

  test('shows the type and the owned scopes of each client', () => {
    assert.match(page, /<code>spa<\/code>.*?<span class="type">public<\/span>/s)
    assert.match(page, /<code>job<\/code>.*?<span class="chip">api:write<\/span>.*?<span class="type conf">confidential<\/span>/s)
  })
})
