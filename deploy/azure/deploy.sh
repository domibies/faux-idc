#!/usr/bin/env bash
# Deploys faux-idc to Azure Container Apps. Re-run it to redeploy; it's idempotent.
# Usage: ./deploy/azure/deploy.sh      (run from the repo root)
#        IMAGE=ghcr.io/domibies/faux-idc:0.2.0 ./deploy/azure/deploy.sh   (upgrade to a version)
set -euo pipefail

DIR="deploy/azure"
RG="${RG:-rg-faux-idc}"
LOCATION="${LOCATION:-westeurope}"
APP="${APP:-faux-idc}"
IMAGE="${IMAGE:-ghcr.io/domibies/faux-idc:latest}"
KEY_FILE="${KEY_FILE:-$DIR/.signing-key.pem}"
ENTRA_FILE="${ENTRA_FILE:-$DIR/.entra.env}"

# Written by deploy/azure/setup-entra.sh; enables the Entra gate when present.
ENTRA_TENANT_ID="" ENTRA_CLIENT_ID="" ENTRA_CLIENT_SECRET=""
[[ -f "$ENTRA_FILE" ]] && source "$ENTRA_FILE"

echo "==> Resource group $RG ($LOCATION)"
az group create -n "$RG" -l "$LOCATION" -o none

# Keep the signing key stable across deploys so issued tokens stay valid.
if [[ ! -f "$KEY_FILE" ]]; then
  echo "==> Generating signing key at $KEY_FILE (keep it, don't commit it)"
  openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$KEY_FILE"
  chmod 600 "$KEY_FILE"
fi
SIGNING_KEY="$(awk '{printf "%s\\n", $0}' "$KEY_FILE")"

echo "==> Deploying $IMAGE"
OUT="$(az deployment group create -g "$RG" -n main -f "$DIR/main.bicep" \
  --parameters appName="$APP" image="$IMAGE" signingKey="$SIGNING_KEY" \
               entraClientId="$ENTRA_CLIENT_ID" entraClientSecret="$ENTRA_CLIENT_SECRET" \
               ${ENTRA_TENANT_ID:+entraTenantId="$ENTRA_TENANT_ID"} \
  --query properties.outputs -o json)"

ISSUER="$(echo "$OUT" | jq -r .issuer.value)"
STORAGE="$(echo "$OUT" | jq -r .storageAccount.value)"
SHARE="$(echo "$OUT" | jq -r .shareName.value)"

# Only upload the default config the first time; after that the share is the source of truth.
SKEY="$(az storage account keys list -n "$STORAGE" -g "$RG" --query '[0].value' -o tsv)"
if [[ "$(az storage file exists --account-name "$STORAGE" --account-key "$SKEY" -s "$SHARE" -p config.yaml --query exists -o tsv)" != "true" ]]; then
  echo "==> Uploading initial config/config.yaml to the share"
  STORAGE="$STORAGE" SHARE="$SHARE" "$DIR/push-config.sh" config/config.yaml
fi

cat <<MSG

Done.
  Issuer:     $ISSUER
  Discovery:  $ISSUER/.well-known/openid-configuration
  Entra gate: ${ENTRA_CLIENT_ID:+ON (app $ENTRA_CLIENT_ID)}${ENTRA_CLIENT_ID:-off (run ./$DIR/setup-entra.sh to enable)}

Change config (applies live, no restart):
  ./$DIR/push-config.sh config/config.yaml
Shell into the container:
  az containerapp exec -n $APP -g $RG --command sh     # then: vi /config/config.yaml
MSG
