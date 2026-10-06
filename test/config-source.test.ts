import { decodeJwt } from 'jose'
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { startServer } from './server.js'

const CONFIG_YAML = `
passwords: [env-pw]
claimSets:
  from-env: { claims: { source: env } }
`

let base = ''
// The sample file exists at this path, as it does in the image.
before(async () => { base = await startServer(CONFIG_YAML, { CONFIG_PATH: 'config/config.yaml' }) })

const passwordGrant = (password: string, claimSet: string) =>
  fetch(`${base}/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'password', client_id: 'cli', username: 'u', password, claim_set: claimSet }),
  })

describe('CONFIG_YAML', () => {
  test('wins over an existing file at CONFIG_PATH', async () => {
    const res = await passwordGrant('env-pw', 'from-env')
    const body = await res.json()
    assert.equal(res.status, 200, JSON.stringify(body))
    assert.equal(decodeJwt(body.access_token).source, 'env')
  })

  test('replaces the file completely', async () => {
    const res = await passwordGrant('letmein', 'admin')
    assert.equal(res.status, 400)
  })
})
