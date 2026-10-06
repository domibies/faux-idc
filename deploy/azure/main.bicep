// faux-idc on Azure Container Apps.
// Config lives on an Azure Files share mounted at /config (hot-reloaded on change).
// The signing key is a Container Apps secret, so tokens survive restarts and new revisions.

@description('Region for all resources.')
param location string = resourceGroup().location

@description('Container app name; becomes part of the issuer URL.')
param appName string = 'faux-idc'

@description('Container image to run. Pin a version (e.g. ghcr.io/domibies/faux-idc:0.1.0): a new tag is what makes Container Apps pull a new image.')
param image string = 'ghcr.io/domibies/faux-idc:latest'

@description('RSA private key (PEM, newlines may be escaped as \\n). Keep it stable to keep tokens valid.')
@secure()
param signingKey string

@description('Storage account for the config share (lowercase, globally unique).')
param storageAccountName string = 'stoidc${uniqueString(resourceGroup().id)}'

@description('Optional: only allow these CIDRs to reach the app, e.g. ["203.0.113.0/24"]. Empty = open.')
param allowedIpRanges array = []

@description('Optional Entra gate: tenant id. Leave the client id empty to disable the gate.')
param entraTenantId string = tenant().tenantId

@description('Optional Entra gate: app registration client id. Empty = gate off.')
param entraClientId string = ''

@description('Optional Entra gate: app registration client secret.')
@secure()
param entraClientSecret string = ''

var entraEnabled = !empty(entraClientId)
var shareName = 'oidc-config'
var envStorageName = 'oidcconfig'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
  }
}

resource fileService 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: fileService
  name: shareName
  properties: { shareQuota: 1 }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${appName}'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'cae-${appName}'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource envStorage 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: env
  name: envStorageName
  properties: {
    azureFile: {
      accountName: storage.name
      accountKey: storage.listKeys().keys[0].value
      shareName: share.name
      // ReadWrite so you can also edit the file from `az containerapp exec`.
      accessMode: 'ReadWrite'
    }
  }
}

var issuer = 'https://${appName}.${env.properties.defaultDomain}'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  dependsOn: [envStorage]
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      // Single revision: codes and refresh tokens live in memory.
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 8080
        transport: 'auto'
        allowInsecure: false
        ipSecurityRestrictions: [for (cidr, i) in allowedIpRanges: {
          name: 'allow-${i}'
          ipAddressRange: cidr
          action: 'Allow'
        }]
      }
      secrets: concat([
        { name: 'signing-key', value: signingKey }
      ], entraEnabled ? [
        { name: 'entra-client-secret', value: entraClientSecret }
      ] : [])
    }
    template: {
      containers: [
        {
          name: 'faux-idc'
          image: image
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          env: concat([
            { name: 'ISSUER', value: issuer }
            { name: 'SIGNING_KEY', secretRef: 'signing-key' }
          ], entraEnabled ? [
            { name: 'ENTRA_ENABLED', value: 'true' }
            { name: 'ENTRA_TENANT_ID', value: entraTenantId }
            { name: 'ENTRA_CLIENT_ID', value: entraClientId }
            { name: 'ENTRA_CLIENT_SECRET', secretRef: 'entra-client-secret' }
          ] : [])
          volumeMounts: [
            { volumeName: 'config', mountPath: '/config' }
          ]
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 8080 }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 8080 }
              periodSeconds: 10
            }
          ]
        }
      ]
      volumes: [
        { name: 'config', storageType: 'AzureFile', storageName: envStorageName }
      ]
      // Exactly one replica: state is in memory, and scale-to-zero would drop refresh tokens.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

output issuer string = issuer
output discoveryUrl string = '${issuer}/.well-known/openid-configuration'
output entraRedirectUri string = '${issuer}/entra/callback'
output storageAccount string = storage.name
output shareName string = share.name
