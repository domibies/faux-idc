#!/usr/bin/env bash
# Creates (or updates) the Entra app registration for the gate, assigns you to it, stores the
# settings in deploy/azure/.entra.env and redeploys with the gate on. Run after a first ./deploy/azure/deploy.sh.
# Usage: ./deploy/azure/setup-entra.sh                               (run from the repo root; client secret)
#        CREDENTIAL=managed-identity ./deploy/azure/setup-entra.sh   (federated credential, no secret)
set -euo pipefail

RG="${RG:-rg-faux-idc}"
APP="${APP:-faux-idc}"
DISPLAY_NAME="${DISPLAY_NAME:-faux-idc gate ($APP)}"
ENTRA_FILE="${ENTRA_FILE:-deploy/azure/.entra.env}"
CREDENTIAL="${CREDENTIAL:-secret}"
[[ "$CREDENTIAL" == secret || "$CREDENTIAL" == managed-identity ]] || { echo "CREDENTIAL must be secret or managed-identity"; exit 1; }

FQDN="$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)"
REDIRECT="https://$FQDN/entra/callback"
TENANT_ID="$(az account show --query tenantId -o tsv)"

APP_ID="$(az ad app list --display-name "$DISPLAY_NAME" --query '[0].appId' -o tsv)"
if [[ -z "$APP_ID" ]]; then
  echo "==> Creating app registration '$DISPLAY_NAME'"
  APP_ID="$(az ad app create --display-name "$DISPLAY_NAME" --sign-in-audience AzureADMyOrg \
    --web-redirect-uris "$REDIRECT" --query appId -o tsv)"
else
  echo "==> Updating redirect URI on existing app registration $APP_ID"
  az ad app update --id "$APP_ID" --web-redirect-uris "$REDIRECT"
fi

SP_ID="$(az ad sp show --id "$APP_ID" --query id -o tsv 2>/dev/null || az ad sp create --id "$APP_ID" --query id -o tsv)"

# Only users/groups assigned to the enterprise app can pass the gate.
az ad sp update --id "$APP_ID" --set appRoleAssignmentRequired=true
ME="$(az ad signed-in-user show --query id -o tsv)"
az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_ID/appRoleAssignedTo" \
  --body "{\"principalId\":\"$ME\",\"resourceId\":\"$SP_ID\",\"appRoleId\":\"00000000-0000-0000-0000-000000000000\"}" \
  -o none 2>/dev/null && echo "==> Assigned you to the app" || echo "==> You are already assigned"

umask 077
if [[ "$CREDENTIAL" == managed-identity ]]; then
  cat > "$ENTRA_FILE" <<ENV
ENTRA_TENANT_ID=$TENANT_ID
ENTRA_CLIENT_ID=$APP_ID
ENTRA_CREDENTIAL=managed-identity
ENV
# Reuse the stored secret for the same app; otherwise create a new one.
elif ! { grep -qx "ENTRA_CLIENT_ID=$APP_ID" "$ENTRA_FILE" && grep -q '^ENTRA_CLIENT_SECRET=.' "$ENTRA_FILE"; } 2>/dev/null; then
  echo "==> Creating client secret (valid 1 year)"
  SECRET="$(az ad app credential reset --id "$APP_ID" --append --display-name faux-idc-gate --years 1 --query password -o tsv)"
  cat > "$ENTRA_FILE" <<ENV
ENTRA_TENANT_ID=$TENANT_ID
ENTRA_CLIENT_ID=$APP_ID
ENTRA_CLIENT_SECRET=$SECRET
ENTRA_CREDENTIAL=secret
ENV
fi

echo "==> Redeploying with the gate on"
ENTRA_FILE="$ENTRA_FILE" ./deploy/azure/deploy.sh

# The deployment created the user-assigned identity of the gate. Let the app registration trust its tokens.
if [[ "$CREDENTIAL" == managed-identity ]]; then
  PRINCIPAL_ID="$(az deployment group show -g "$RG" -n main --query properties.outputs.entraIdentityPrincipalId.value -o tsv)"
  FIC_NAME="faux-idc-gate-$APP"
  FIC="{\"issuer\":\"https://login.microsoftonline.com/$TENANT_ID/v2.0\",\"subject\":\"$PRINCIPAL_ID\",\"audiences\":[\"api://AzureADTokenExchange\"],\"description\":\"Managed identity of the faux-idc container app $APP\"}"
  if [[ -n "$(az ad app federated-credential list --id "$APP_ID" --query "[?name=='$FIC_NAME'].name" -o tsv)" ]]; then
    echo "==> Updating federated credential $FIC_NAME"
    az ad app federated-credential update --id "$APP_ID" --federated-credential-id "$FIC_NAME" --parameters "$FIC" -o none
  else
    echo "==> Adding federated credential $FIC_NAME (trusts managed identity $PRINCIPAL_ID)"
    az ad app federated-credential create --id "$APP_ID" --parameters "{\"name\":\"$FIC_NAME\",${FIC#\{}" -o none
  fi
fi

cat <<MSG

Entra gate is on ($CREDENTIAL). To let colleagues in, assign them (or a group) in the Entra admin center:
  Enterprise applications > $DISPLAY_NAME > Users and groups > Add user/group
MSG
