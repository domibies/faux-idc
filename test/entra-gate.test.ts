import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { startFakeEntra, startServer } from './server.js'

// Runs the whole gate round trip against test/fake-entra.mjs: faux-idc → Entra authorize → callback → form.
const TENANT = '11111111-2222-3333-4444-555555555555'
const MI_CLIENT_ID = '33333333-3333-3333-3333-333333333333'
const CONFIG_YAML = 'claimSets: { default: { claims: {} } }'

let entra = ''
before(async () => { entra = await startFakeEntra() })

const gateEnv = (credential: Record<string, string>) => ({
  ENTRA_ENABLED: 'true', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: 'gate-app', ENTRA_AUTHORITY_HOST: entra, ...credential,
})

/** Follows the gate redirects by hand and returns the response of the faux-idc callback. */
async function passGate(base: string) {
  const query = new URLSearchParams({ response_type: 'code', client_id: 'app', redirect_uri: 'http://app/cb', scope: 'openid' })
  let res = await fetch(`${base}/authorize?${query}`, { redirect: 'manual' })
  assert.equal(res.status, 302)
  res = await fetch(res.headers.get('location')!, { redirect: 'manual' }) // fake Entra sign-in
  return fetch(res.headers.get('location')!, { redirect: 'manual' }) // faux-idc /entra/callback
}

async function assertSignedIn(base: string) {
  const res = await passGate(base)
  assert.equal(res.status, 302, await res.text())
  assert.match(res.headers.get('location')!, /^\/authorize\?/)
  const cookie = res.headers.get('set-cookie')!.split(';')[0]
  const form = await (await fetch(new URL(res.headers.get('location')!, base), { headers: { cookie } })).text()
  assert.match(form, /test\.user@example\.com/)
}

async function assertGateError(base: string, message: RegExp) {
  const res = await passGate(base)
  assert.ok(res.status >= 400, `expected an error page, got ${res.status}`)
  assert.match(await res.text(), message)
}

describe('Entra gate with a client secret', () => {
  test('signs in', async () => {
    await assertSignedIn(await startServer(CONFIG_YAML, gateEnv({ ENTRA_CLIENT_SECRET: 'gate-secret' })))
  })
})

describe('Entra gate with a managed identity', () => {
  let base = ''
  before(async () => {
    base = await startServer(CONFIG_YAML, gateEnv({
      ENTRA_CLIENT_ASSERTION: 'managed-identity', ENTRA_MANAGED_IDENTITY_CLIENT_ID: MI_CLIENT_ID,
      IDENTITY_ENDPOINT: `${entra}/msi/token`, IDENTITY_HEADER: 'fake-identity-header',
    }))
  })

  test('signs in with the managed identity token as client assertion', async () => {
    await assertSignedIn(base)
  })

  test('reuses the managed identity token until shortly before it expires', async () => {
    await assertSignedIn(base)
    assert.equal((await (await fetch(`${entra}/msi/calls`)).json()).calls, 1)
  })

  test('shows an error when the identity endpoint rejects the identity', async () => {
    const other = await startServer(CONFIG_YAML, gateEnv({
      ENTRA_CLIENT_ASSERTION: 'managed-identity', ENTRA_MANAGED_IDENTITY_CLIENT_ID: '00000000-0000-0000-0000-000000000000',
      IDENTITY_ENDPOINT: `${entra}/msi/token`, IDENTITY_HEADER: 'fake-identity-header',
    }))
    await assertGateError(other, /managed identity endpoint returned no token \(Unable to load the proper Managed Identity\.\)/)
  })

  test('shows an error when there is no identity endpoint', async () => {
    const other = await startServer(CONFIG_YAML, gateEnv({
      ENTRA_CLIENT_ASSERTION: 'managed-identity', ENTRA_MANAGED_IDENTITY_CLIENT_ID: MI_CLIENT_ID, IDENTITY_ENDPOINT: '', IDENTITY_HEADER: '',
    }))
    await assertGateError(other, /IDENTITY_ENDPOINT and IDENTITY_HEADER are not set/)
  })
})

describe('Entra gate with a federated token file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'faux-idc-'))
  const file = join(dir, 'azure-identity-token')
  after(() => rmSync(dir, { recursive: true, force: true }))
  let base = ''
  before(async () => {
    base = await startServer(CONFIG_YAML, gateEnv({ ENTRA_CLIENT_ASSERTION: 'token-file', AZURE_FEDERATED_TOKEN_FILE: file }))
  })

  test('signs in with the token in the file as client assertion', async () => {
    writeFileSync(file, await (await fetch(`${entra}/k8s/token`)).text())
    await assertSignedIn(base)
  })

  test('shows the Entra error when Entra does not trust the token', async () => {
    writeFileSync(file, await (await fetch(`${entra}/k8s/token?sub=system:serviceaccount:default:other`)).text())
    await assertGateError(base, /Token exchange with Microsoft failed: bad client secret or assertion/)
  })

  test('shows an error when the file is missing', async () => {
    rmSync(file, { force: true })
    await assertGateError(base, /Could not read the federated token file/)
  })
})

describe('Entra gate configuration at startup', () => {
  test('refuses to start with a client secret and a client assertion', async () => {
    await assert.rejects(
      startServer(CONFIG_YAML, gateEnv({ ENTRA_CLIENT_SECRET: 'gate-secret', ENTRA_CLIENT_ASSERTION: 'managed-identity' })),
      /process exited \(1\)[\s\S]*mutually exclusive/,
    )
  })

  test('refuses to start without a credential', async () => {
    await assert.rejects(startServer(CONFIG_YAML, gateEnv({})), /process exited \(1\)[\s\S]*is required/)
  })
})
