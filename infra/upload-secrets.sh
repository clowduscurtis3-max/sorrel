#!/bin/bash
# Run this yourself, locally, in your own terminal - NOT through Claude.
# Reads server/.env and uploads each value into AWS SSM Parameter Store as
# an encrypted SecureString under /sorrel/<KEY>. The EC2 instance's own IAM
# role can only read that one path prefix (see infra/ - sorrel-param-store-read
# policy), nothing else in your AWS account.
#
# BACKEND_URL is deliberately overridden below to the real production
# hostname, regardless of whatever's currently in your local .env (which is
# still pointed at your ngrok tunnel for local dev) - production needs the
# real domain, not your dev tunnel.
set -euo pipefail

ENV_FILE="$(dirname "$0")/../server/.env"
REGION=us-east-1

if [ ! -f "$ENV_FILE" ]; then
  echo "Can't find $ENV_FILE - run this from inside the repo." >&2
  exit 1
fi

echo "Uploading secrets from $ENV_FILE to SSM Parameter Store (region: $REGION)..."
echo ""

upload() {
  local key="$1"
  local value="$2"
  if [ -z "$value" ]; then
    echo "  SKIP  $key (empty in .env - fill it in first if this is required)"
    return
  fi
  aws ssm put-parameter \
    --name "/sorrel/$key" \
    --value "$value" \
    --type SecureString \
    --overwrite \
    --region "$REGION" > /dev/null
  echo "  OK    $key"
}

while IFS='=' read -r key value; do
  # Skip blank lines and comments.
  [[ -z "$key" || "$key" == \#* ]] && continue
  key="$(echo "$key" | xargs)"

  if [ "$key" == "BACKEND_URL" ]; then
    upload "$key" "https://api.sorrel-app.com"
    continue
  fi

  upload "$key" "$value"
done < "$ENV_FILE"

echo ""
echo "Done. Verifying what actually landed (names only, values stay encrypted):"
aws ssm get-parameters-by-path --path /sorrel/ --region "$REGION" --query "Parameters[].Name" --output table
