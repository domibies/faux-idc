# Deploy faux-idc to Azure Container Apps

This folder contains an example deployment of the published faux-idc image to Azure Container Apps.
faux-idc does not need Azure; use this example only if you want to run it there.

The deployment creates these resources:

- A Container Apps environment with a Log Analytics workspace.
- The faux-idc container app with HTTPS ingress and exactly one replica.
- A storage account with an Azure Files share. The share is mounted at `/config` and holds `config.yaml`.
- A container app secret that holds the signing key.
- Only with the Entra gate and `CREDENTIAL=managed-identity`: a user-assigned managed identity for the gate.

The deployment sets the issuer to `https://<app>.<environment domain>`.

## Prerequisites

- The Azure CLI (`az`), signed in with `az login`.
- `jq` and `openssl`.
- Run all scripts from the root of the repository.

## Deploy

```bash
./deploy/azure/deploy.sh                    # optional: RG=… LOCATION=… APP=… IMAGE=…
```

The script does these steps:

1. It creates the resource group `rg-faux-idc` if it does not exist.
2. It creates a signing key in `deploy/azure/.signing-key.pem` if that file does not exist.
3. It deploys [`main.bicep`](main.bicep) with the image `ghcr.io/domibies/faux-idc:latest`.
4. At the first deployment only, it uploads `config/config.yaml` to the file share.

You can run the script again at any time. It changes only what is different.

## Upgrade

Container Apps pulls an image again only when the image reference changes. Thus, deploy a specific version:

```bash
IMAGE=ghcr.io/domibies/faux-idc:0.2.0 ./deploy/azure/deploy.sh
```

If you run the script again with the same tag (for example `latest`), Container Apps keeps the image that it already has.

## Operate

- **Change the configuration:** run `./deploy/azure/push-config.sh config/config.yaml`. The script
  uploads the file to the share, and faux-idc reads it again at the next request. You can also edit the
  file in the storage browser of the Azure portal. Or open a shell with
  `az containerapp exec -n faux-idc -g rg-faux-idc --command sh` and edit `/config/config.yaml`.
- **One replica, always on:** codes and refresh tokens are in memory. Thus, the template sets the
  minimum and maximum number of replicas to 1. Do not scale out.
- **Signing key:** the script creates the key one time and uses it again at each deployment, so issued
  tokens stay valid. Keep `deploy/azure/.signing-key.pem`. Git ignores this file; do not commit it.
- **Restrict access:** to allow only some IP address ranges, pass the Bicep parameter
  `allowedIpRanges='["203.0.113.0/24"]'`.
- **Issuer:** apps in the same Container Apps environment must also use the public URL, so that `iss` is the same for all apps.

## Turn on the Entra gate

After the first deployment, run one of these commands:

```bash
./deploy/azure/setup-entra.sh                               # the gate uses a client secret
CREDENTIAL=managed-identity ./deploy/azure/setup-entra.sh   # the gate uses a managed identity, no secret
```

The script does these steps:

1. It creates the app registration *faux-idc gate (faux-idc)* with the correct redirect URI, or updates it.
2. It sets *Assignment required* on the enterprise application and assigns you to it.
3. It writes the gate settings to `deploy/azure/.entra.env`. Git ignores this file. With a client
   secret, the script creates the secret and writes it to this file.
4. It deploys again with the gate on.
5. With `CREDENTIAL=managed-identity` only: it adds a federated credential to the app registration.

With `CREDENTIAL=managed-identity`, the deployment creates the user-assigned managed identity
`id-<app>` and assigns it to the container app. The federated credential lets the app registration
trust the tokens of this identity. Thus, the app registration needs no client secret. Use this
option if your organisation does not allow client secrets. For more information, see
[Sign in to Entra without a client secret](../../README.md#sign-in-to-entra-without-a-client-secret).

To change from a client secret to a managed identity, run the script again with
`CREDENTIAL=managed-identity`. Then delete the old client secret *faux-idc-gate* from the app
registration. You can change back in the same way.

To give access to other people, go to the Entra admin center. Open *Enterprise applications* >
*faux-idc gate (faux-idc)* > *Users and groups*, and add the users or groups.

For more information about the gate, see [Optional: Microsoft Entra gate](../../README.md#optional-microsoft-entra-gate).
