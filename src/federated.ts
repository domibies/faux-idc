/**
 * How the Entra gate proves its own identity to Microsoft: a client secret, or a client assertion.
 * An assertion is a token of a workload (a managed identity, a Kubernetes service account) that the app
 * registration trusts through a federated identity credential, so the app needs no secret.
 */
import { readFile } from 'node:fs/promises'
import type { EntraConfig } from './config.js'

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer'

/** The audience that Entra expects in the assertion, per cloud. */
function exchangeAudience(authorityHost: string): string {
  const host = new URL(authorityHost).hostname
  if (host === 'login.microsoftonline.us') return 'api://AzureADTokenExchangeUSGov'
  if (host === 'login.chinacloudapi.cn') return 'api://AzureADTokenExchangeChina'
  return 'api://AzureADTokenExchange'
}

let cached: { key: string; token: string; expiresAt: number } | undefined

/** A token of a user-assigned managed identity from the local identity endpoint (Container Apps, App Service). */
async function managedIdentityToken(clientId: string, resource: string): Promise<string> {
  const key = `${clientId} ${resource}`
  // Refresh five minutes before expiry, so a token never expires between here and Entra.
  if (cached?.key === key && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token

  const { IDENTITY_ENDPOINT: endpoint, IDENTITY_HEADER: header } = process.env
  if (!endpoint || !header) {
    throw new Error('No managed identity is available: IDENTITY_ENDPOINT and IDENTITY_HEADER are not set. ' +
      'Assign the user-assigned identity to this app, or use a client secret.')
  }
  const url = new URL(endpoint)
  url.searchParams.set('resource', resource)
  url.searchParams.set('api-version', '2019-08-01')
  url.searchParams.set('client_id', clientId)

  let res: Response
  try {
    res = await fetch(url, { headers: { 'X-IDENTITY-HEADER': header } })
  } catch (err) {
    throw new Error(`The managed identity endpoint is not reachable: ${(err as Error).message}`)
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, string>
  if (!res.ok || !body.access_token) {
    throw new Error(`The managed identity endpoint returned no token (${body.error_description ?? body.error ?? res.status}). ` +
      `Check that the identity ${clientId} is assigned to this app.`)
  }
  cached = { key, token: body.access_token, expiresAt: Number(body.expires_on) * 1000 }
  return body.access_token
}

/** A token from a file that the platform keeps fresh, e.g. AZURE_FEDERATED_TOKEN_FILE. Read on every use. */
async function fileToken(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim()
  } catch (err) {
    throw new Error(`Could not read the federated token file: ${(err as Error).message}`)
  }
}

/** The client authentication parameters for a request to the Entra token endpoint. */
export async function entraClientAuth(cfg: EntraConfig): Promise<Record<string, string>> {
  const c = cfg.credential
  if (c.type === 'secret') return { client_secret: c.secret }
  const assertion = c.type === 'managed-identity'
    ? await managedIdentityToken(c.managedIdentityClientId, exchangeAudience(cfg.authorityHost))
    : await fileToken(c.federatedTokenFile)
  return { client_assertion_type: ASSERTION_TYPE, client_assertion: assertion }
}
