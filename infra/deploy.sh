#!/bin/bash
# Runs on the EC2 instance via SSM RunCommand, triggered by the GitHub
# Actions deploy workflow after tests pass. Pulls the just-uploaded build
# artifact from the private deploy bucket and restarts the service - no
# git, no GitHub credential of any kind ever touches this box.
set -euo pipefail

BUCKET=sorrel-deploy-860803563132
TMP=/tmp/sorrel-deploy
rm -rf "$TMP"
mkdir -p "$TMP"

aws s3 cp "s3://${BUCKET}/server.zip" "$TMP/server.zip" --region us-east-1
unzip -oq "$TMP/server.zip" -d "$TMP/server"

rsync -a --delete --exclude ".env" "$TMP/server/" /opt/sorrel/server/
chown -R sorrel:sorrel /opt/sorrel/server

cd /opt/sorrel/server
sudo -u sorrel npm ci --omit=dev

systemctl restart sorrel-backend
sleep 2
if systemctl is-active --quiet sorrel-backend; then
  echo "DEPLOY_OK"
else
  echo "DEPLOY_FAILED"
  journalctl -u sorrel-backend -n 50 --no-pager
  exit 1
fi

rm -rf "$TMP"
