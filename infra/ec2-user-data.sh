#!/bin/bash
# Runs once, on first boot, via EC2 user-data. Installs the runtime and
# wires up the systemd service + Caddy reverse proxy. It does NOT deploy
# any app code - the first real deploy lands via the GitHub Actions
# pipeline (infra/deploy.sh, run over SSM) right after this finishes.
set -euo pipefail
exec > /var/log/sorrel-bootstrap.log 2>&1

dnf update -y

# 1GB RAM on a t4g.micro is enough to run the app, but tight for `npm ci`
# alongside it - a swap file is a cheap, standard safety margin.
fallocate -l 1G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile swap swap defaults 0 0' >> /etc/fstab

curl -fsSL https://rpm.nodesource.com/setup_26.x | bash -
dnf install -y nodejs python3 unzip rsync
node -v

# Caddy's official RPM repo has no Amazon Linux 2023 ARM64 build target,
# so this installs the official static binary directly instead (handles
# auto-HTTPS/Let's Encrypt for us either way).
dnf install -y libcap
curl -o /usr/local/bin/caddy -fsSL "https://caddyserver.com/api/download?os=linux&arch=arm64"
chmod +x /usr/local/bin/caddy
setcap cap_net_bind_service=+ep /usr/local/bin/caddy

groupadd --system caddy
useradd --system --gid caddy --home-dir /var/lib/caddy --shell /sbin/nologin --comment "Caddy web server" caddy
mkdir -p /var/lib/caddy /var/log/caddy /etc/caddy
chown -R caddy:caddy /var/lib/caddy /var/log/caddy

cat > /etc/systemd/system/caddy.service << 'CADDYSVCEOF'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
LimitNPROC=512
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
CADDYSVCEOF

useradd --system --home-dir /opt/sorrel --shell /sbin/nologin sorrel
mkdir -p /opt/sorrel/server
chown -R sorrel:sorrel /opt/sorrel

cat > /opt/sorrel/fetch-env.sh << 'FETCHENV'
FETCH_ENV_PLACEHOLDER
FETCHENV
chmod 700 /opt/sorrel/fetch-env.sh
chown sorrel:sorrel /opt/sorrel/fetch-env.sh

cat > /etc/systemd/system/sorrel-backend.service << 'SVCEOF'
SERVICE_PLACEHOLDER
SVCEOF

cat > /etc/caddy/Caddyfile << 'CADDYEOF'
CADDY_PLACEHOLDER
CADDYEOF

systemctl daemon-reload
systemctl enable caddy
systemctl restart caddy
systemctl enable sorrel-backend
# Not started yet - no app code deployed until the first CI/CD run.

echo "Bootstrap complete."
