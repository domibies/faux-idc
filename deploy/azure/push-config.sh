#!/usr/bin/env bash
# Uploads a config file to the Azure Files share; the running app picks it up within a second.
# Usage: ./deploy/azure/push-config.sh [path/to/config.yaml]   (run from the repo root)
set -euo pipefail

RG="${RG:-rg-faux-idc}"
FILE="${1:-config/config.yaml}"
# Storage account and share names come from the outputs of the last ./deploy/azure/deploy.sh run.
if [[ -z "${STORAGE:-}" || -z "${SHARE:-}" ]]; then
  OUT="$(az deployment group show -g "$RG" -n main --query properties.outputs -o json)"
  STORAGE="${STORAGE:-$(echo "$OUT" | jq -r .storageAccount.value)}"
  SHARE="${SHARE:-$(echo "$OUT" | jq -r .shareName.value)}"
fi
KEY="$(az storage account keys list -n "$STORAGE" -g "$RG" --query '[0].value' -o tsv)"

# Catch YAML typos before they reach the server (it would keep the old config anyway).
if command -v node >/dev/null && [[ -d node_modules/yaml ]]; then
  node -e "require('yaml').parse(require('fs').readFileSync('$FILE','utf8'))" \
    || { echo "YAML error in $FILE, not uploading"; exit 1; }
fi

az storage file upload --account-name "$STORAGE" --account-key "$KEY" \
  -s "$SHARE" --source "$FILE" --path config.yaml -o none
echo "Uploaded $FILE to $STORAGE/$SHARE/config.yaml"
