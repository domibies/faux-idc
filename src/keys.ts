import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { calculateJwkThumbprint, exportJWK, type JWK } from 'jose'

export interface SigningKeys {
  privateKey: KeyObject
  publicKey: KeyObject
  publicJwk: JWK
  kid: string
}

/**
 * Loads the RS256 signing key from SIGNING_KEY_PATH, generating (and saving) one if it doesn't exist.
 * Without SIGNING_KEY_PATH the key is ephemeral and tokens are invalidated on restart.
 */
export async function loadKeys(): Promise<SigningKeys> {
  const path = process.env.SIGNING_KEY_PATH
  let privateKey: KeyObject

  if (process.env.SIGNING_KEY) {
    privateKey = createPrivateKey(process.env.SIGNING_KEY.replace(/\\n/g, '\n'))
    console.log('[keys] using key from SIGNING_KEY')
  } else if (path && existsSync(path)) {
    privateKey = createPrivateKey(readFileSync(path, 'utf8'))
    console.log(`[keys] loaded signing key from ${path}`)
  } else {
    privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    if (path) {
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
        console.log(`[keys] generated new signing key at ${path}`)
      } catch (err) {
        console.warn(`[keys] could not write ${path} (${(err as Error).message}); key is ephemeral`)
      }
    } else {
      console.log('[keys] generated ephemeral signing key (set SIGNING_KEY_PATH to persist it)')
    }
  }

  const publicKey = createPublicKey(privateKey)
  const jwk = await exportJWK(publicKey)
  const kid = await calculateJwkThumbprint(jwk)
  return { privateKey, publicKey, publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' }, kid }
}
