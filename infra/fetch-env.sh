#!/bin/bash
# Runs as ExecStartPre for sorrel-backend.service. Pulls every SecureString
# parameter under /sorrel/ from SSM Parameter Store and writes them as a
# plain KEY=VALUE env file for systemd's EnvironmentFile to load. Never
# logs values - only ever writes them straight to a 600-permission file.
set -euo pipefail

ENV_FILE=/opt/sorrel/server/.env
: > "$ENV_FILE"
chmod 600 "$ENV_FILE"

aws ssm get-parameters-by-path \
  --path /sorrel/ \
  --with-decryption \
  --region us-east-1 \
  --query "Parameters[].{Name:Name,Value:Value}" \
  --output json |
  python3 -c "
import json, sys
for p in json.load(sys.stdin):
    key = p['Name'].rsplit('/', 1)[-1]
    val = p['Value'].replace('\n', '\\\\n')
    print(f'{key}={val}')
" >> "$ENV_FILE"

chmod 600 "$ENV_FILE"
