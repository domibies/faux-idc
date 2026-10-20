import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { parseConfig, visibleClaimSets } from '../src/config.js'
import { startServer } from './server.js'

// `admin` is hidden: only the secret usernames see it. `shop-admin` is hidden and belongs to a pack scope.
const CONFIG_YAML = `
passwords: [pw]
claimSets:
  user: { description: Regular user, claims: {} }
  admin: { description: Full access, usernames: [Sysop, gandalf], claims: { roles: [admin] } }
  shop-admin: { scopes: [pack:shop], usernames: [sysop], claims: {} }
  shop-customer: { scopes: [pack:shop], claims: {} }
  secret-only: { scopes: [pack:secret], usernames: [sysop], claims: {} }
`

const cfg = parseConfig({
  passwords: ['pw'],
  claimSets: {
    user: { claims: {} },
    admin: { usernames: ['Sysop', 'gandalf'], claims: {} },
    'shop-admin': { scopes: ['pack:shop'], usernames: ['sysop'], claims: {} },
    'shop-customer': { scopes: ['pack:shop'], claims: {} },
  },
})

describe('usernames in the config', () => {
  test('is optional', () => {
    assert.deepEqual(parseConfig({ claimSets: { a: { claims: {} } } }).claimSets.a.usernames, [])
  })

  test('must be a list', () => {
    assert.throws(() => parseConfig({ claimSets: { a: { usernames: 'root', claims: {} } } }), /claimSets\.a\.usernames must be a list/)
  })
})

describe('visibleClaimSets', () => {
  test('hides a claim set with usernames from other usernames', () => {
    assert.deepEqual(visibleClaimSets(cfg, 'openid', 'alice'), ['user'])
  })

  test('shows a claim set to one of its usernames', () => {
    assert.deepEqual(visibleClaimSets(cfg, 'openid', 'gandalf'), ['user', 'admin'])
  })

  test('matches the username without case and surrounding spaces', () => {
    assert.deepEqual(visibleClaimSets(cfg, 'openid', '  SYSOP '), ['user', 'admin'])
  })

  test('applies the scope rules first', () => {
    assert.deepEqual(visibleClaimSets(cfg, 'openid pack:shop', 'alice'), ['shop-customer'])
    assert.deepEqual(visibleClaimSets(cfg, 'openid pack:shop', 'sysop'), ['shop-admin', 'shop-customer'])
  })
})

describe('the server', () => {
  let base = ''
  before(async () => { base = await startServer(CONFIG_YAML) })

  const authorizeQuery = (extra: Record<string, string> = {}) => new URLSearchParams({
    response_type: 'code', client_id: 'app', redirect_uri: 'http://app/cb', scope: 'openid', state: 'st', ...extra,
  })

  async function loginPage(extra: Record<string, string> = {}, headers: Record<string, string> = {}) {
    const res = await fetch(`${base}/authorize?${authorizeQuery(extra)}`, { headers })
    assert.equal(res.status, 200)
    return res.text()
  }

  const claimSets = async (query: Record<string, string>) =>
    (await fetch(`${base}/claim-sets?${new URLSearchParams(query)}`)).json()

  describe('GET /claim-sets', () => {
    test('returns the visible claim sets with their descriptions', async () => {
      assert.deepEqual(await claimSets({ username: 'alice', scope: 'openid' }), [{ name: 'user', description: 'Regular user' }])
    })

    test('adds the hidden claim sets that the username unlocks', async () => {
      assert.deepEqual(await claimSets({ username: 'sysop', scope: 'openid' }), [
        { name: 'user', description: 'Regular user' },
        { name: 'admin', description: 'Full access' },
      ])
    })

    test('applies the scope rules', async () => {
      assert.deepEqual(await claimSets({ username: 'sysop', scope: 'openid pack:shop' }), [
        { name: 'shop-admin', description: '' },
        { name: 'shop-customer', description: '' },
      ])
    })
  })

  describe('the sign-in form', () => {
    test('does not offer a hidden claim set to other usernames', async () => {
      const page = await loginPage({ login_hint: 'alice' })
      assert.match(page, /<option value="user"/)
      assert.doesNotMatch(page, /<option value="admin"/)
    })

    test('offers a hidden claim set to one of its usernames', async () => {
      assert.match(await loginPage({ login_hint: 'sysop' }), /<option value="admin"/)
    })

    test('selects the remembered hidden claim set for its username', async () => {
      const page = await loginPage({}, { cookie: 'faux_idc_user=gandalf; faux_idc_claimset=admin' })
      assert.match(page, /<option value="admin" selected>/)
    })

    test('does not contain the secret usernames', async () => {
      assert.doesNotMatch(await loginPage({ login_hint: 'alice' }), /sysop|gandalf/i)
    })

    test('accepts a hidden claim set for any username', async () => {
      const body = new URLSearchParams({ ...Object.fromEntries(authorizeQuery()), username: 'alice', password: 'pw', claim_set: 'admin' })
      const res = await fetch(`${base}/authorize`, { method: 'POST', body, redirect: 'manual' })
      assert.equal(res.status, 302)
    })

    test('explains when the username sees no claim set', async () => {
      const query = Object.fromEntries(authorizeQuery({ scope: 'openid pack:secret' }))
      const body = new URLSearchParams({ ...query, username: 'alice', password: 'pw' })
      const res = await fetch(`${base}/authorize`, { method: 'POST', body, redirect: 'manual' })
      assert.equal(res.status, 401)
      assert.match(await res.text(), /No claim set is available for this username/)
    })
  })

  test('the password grant accepts a hidden claim set for any username', async () => {
    const res = await fetch(`${base}/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'password', client_id: 'app', username: 'alice', password: 'pw', claim_set: 'admin' }),
    })
    assert.equal(res.status, 200)
  })

  test('the home page does not list hidden claim sets', async () => {
    const page = await (await fetch(`${base}/`)).text()
    assert.match(page, /<code>user<\/code>/)
    assert.doesNotMatch(page, /<code>admin<\/code>|<code>shop-admin<\/code>/)
  })
})

describe('GET /claim-sets with the Entra gate on', () => {
  test('requires the Entra session', async () => {
    const base = await startServer('claimSets: { default: { claims: {} } }', {
      ENTRA_ENABLED: 'true', ENTRA_TENANT_ID: 't', ENTRA_CLIENT_ID: 'c', ENTRA_CLIENT_SECRET: 's',
    })
    const res = await fetch(`${base}/claim-sets?username=alice`)
    assert.equal(res.status, 401)
  })
})
