import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { parseConfig } from '../src/config.js'

const ID = '00000000-0000-0000-0000-000000000000'
const gate = (entra: Record<string, unknown>) =>
  parseConfig({ entra: { enabled: true, tenantId: ID, clientId: ID, ...entra } }).entra

const ENV_NAMES = ['ENTRA_CLIENT_SECRET', 'ENTRA_CLIENT_ASSERTION', 'ENTRA_MANAGED_IDENTITY_CLIENT_ID', 'AZURE_FEDERATED_TOKEN_FILE']
afterEach(() => { for (const name of ENV_NAMES) delete process.env[name] })

describe('Entra gate credential', () => {
  test('uses a client secret', () => {
    assert.deepEqual(gate({ clientSecret: 's3cret' })?.credential, { type: 'secret', secret: 's3cret' })
  })

  test('uses a managed identity assertion', () => {
    assert.deepEqual(gate({ clientAssertion: 'managed-identity', managedIdentityClientId: ID })?.credential, {
      type: 'managed-identity', managedIdentityClientId: ID,
    })
  })

  test('uses a federated token file', () => {
    assert.deepEqual(gate({ clientAssertion: 'token-file', federatedTokenFile: '/var/run/token' })?.credential, {
      type: 'token-file', federatedTokenFile: '/var/run/token',
    })
  })

  test('reads the assertion settings from the environment', () => {
    process.env.ENTRA_CLIENT_ASSERTION = 'managed-identity'
    process.env.ENTRA_MANAGED_IDENTITY_CLIENT_ID = ID
    assert.deepEqual(gate({})?.credential, { type: 'managed-identity', managedIdentityClientId: ID })
  })

  test('reads the token file path from AZURE_FEDERATED_TOKEN_FILE', () => {
    process.env.AZURE_FEDERATED_TOKEN_FILE = '/var/run/token'
    assert.deepEqual(gate({ clientAssertion: 'token-file' })?.credential, { type: 'token-file', federatedTokenFile: '/var/run/token' })
  })

  test('refuses a secret and an assertion together', () => {
    assert.throws(() => gate({ clientSecret: 's3cret', clientAssertion: 'managed-identity', managedIdentityClientId: ID }),
      /entra\.clientSecret and entra\.clientAssertion are mutually exclusive/)
  })

  test('refuses a secret from the environment together with an assertion from the file', () => {
    process.env.ENTRA_CLIENT_SECRET = 's3cret'
    assert.throws(() => gate({ clientAssertion: 'managed-identity', managedIdentityClientId: ID }), /mutually exclusive/)
  })

  test('refuses a gate without a credential', () => {
    assert.throws(() => gate({}), /entra\.clientSecret or entra\.clientAssertion is required/)
  })

  test('refuses an unknown assertion type', () => {
    assert.throws(() => gate({ clientAssertion: 'certificate' }), /entra\.clientAssertion must be managed-identity or token-file/)
  })

  test('refuses a managed identity assertion without the identity client id', () => {
    assert.throws(() => gate({ clientAssertion: 'managed-identity' }), /entra\.managedIdentityClientId is required/)
  })

  test('refuses a token file assertion without a path', () => {
    assert.throws(() => gate({ clientAssertion: 'token-file' }), /entra\.federatedTokenFile is required/)
  })
})
