import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { claimSetsFor, parseConfig, resolveClaimSet } from '../src/config.js'

const packs = parseConfig({
  passwords: ['pw'],
  claimSets: {
    default: { claims: {} },
    'shop-customer': { scopes: ['pack:shop'], claims: {} },
    'shop-staff': { scopes: ['pack:shop'], claims: {} },
    'hr-employee': { scopes: ['pack:hr'], claims: {} },
    fallback: { claims: {} },
  },
})

describe('claimSetsFor', () => {
  test('offers every claim set when no claim set has scopes', () => {
    const cfg = parseConfig({ passwords: ['pw'], claimSets: { a: { claims: {} }, b: { claims: {} } } })
    assert.deepEqual(claimSetsFor(cfg, 'openid'), ['a', 'b'])
  })

  test('offers only the claim sets of a requested pack scope', () => {
    assert.deepEqual(claimSetsFor(packs, 'openid pack:shop'), ['shop-customer', 'shop-staff'])
  })

  test('offers the claim sets of all requested pack scopes, in config order', () => {
    assert.deepEqual(claimSetsFor(packs, 'pack:hr openid pack:shop'), ['shop-customer', 'shop-staff', 'hr-employee'])
  })

  test('offers only untagged claim sets when no pack scope is requested', () => {
    assert.deepEqual(claimSetsFor(packs, 'openid profile'), ['default', 'fallback'])
  })

  test('treats a missing scope like a request without a pack scope', () => {
    assert.deepEqual(claimSetsFor(packs, undefined), ['default', 'fallback'])
  })

  test('offers untagged claim sets when the requested scope matches no pack', () => {
    assert.deepEqual(claimSetsFor(packs, 'openid pack:unknown'), ['default', 'fallback'])
  })

  test('offers nothing when every claim set has scopes and none of them is requested', () => {
    const cfg = parseConfig({ passwords: ['pw'], claimSets: { a: { scopes: ['pack:a'], claims: {} } } })
    assert.deepEqual(claimSetsFor(cfg, 'openid'), [])
  })
})

describe('resolveClaimSet', () => {
  test('returns the requested claim set when the scope allows it', () => {
    assert.deepEqual(resolveClaimSet(packs, 'openid pack:shop', 'shop-staff'), { claimSet: 'shop-staff' })
  })

  test('returns the first allowed claim set when none is requested', () => {
    assert.deepEqual(resolveClaimSet(packs, 'openid pack:shop'), { claimSet: 'shop-customer' })
  })

  test('rejects a requested claim set that the scope does not allow', () => {
    assert.deepEqual(resolveClaimSet(packs, 'openid pack:shop', 'default'), {
      error: 'Claim set "default" is not available for scope "openid pack:shop"',
    })
  })

  test('rejects the request when no claim set is available for the scope', () => {
    const cfg = parseConfig({ passwords: ['pw'], claimSets: { a: { scopes: ['pack:a'], claims: {} } } })
    assert.deepEqual(resolveClaimSet(cfg, 'openid'), { error: 'No claim set is available for scope "openid"' })
  })
})

describe('parseConfig scopes', () => {
  test('rejects scopes that are not a list', () => {
    assert.throws(
      () => parseConfig({ passwords: ['pw'], claimSets: { a: { scopes: 'pack:shop', claims: {} } } }),
      /claimSets\.a\.scopes must be a list/,
    )
  })
})
