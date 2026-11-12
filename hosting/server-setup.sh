#!/bin/bash
# The server's first boot, run once as EC2 user data. Amazon Linux 2023, ARM (t4g.small).
# Installs Docker, makes the shared network, clones the (public) repo, writes each company's
# settings with fresh passwords, and starts the deploy agent. The passwords are generated
# here and never leave the server. Progress: /var/log/cloud-init-output.log.
set -euxo pipefail

dnf install -y docker git dnf-automatic
systemctl enable --now docker

# Amazon Linux packages Docker but not its compose plugin.
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL -o /usr/local/lib/docker/cli-plugins/docker-compose \
  https://github.com/docker/compose/releases/download/v2.39.1/docker-compose-linux-aarch64
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# A safety net for memory: about 350 MB is used of 2 GB.
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile swap swap defaults 0 0' >> /etc/fstab

# Security updates, applied automatically.
sed -i 's/^apply_updates = .*/apply_updates = yes/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic.timer

# The three companies' stacks meet only on this network.
docker network create trading

git clone https://github.com/snoopy55619819/trading-platform.git /opt/trading-platform
cd /opt/trading-platform

secret() { openssl rand -hex 24; }
umask 077
cat > exchange-alpha/deploy/.env <<ENV
EXCHANGE_DB_PASSWORD=$(secret)
ENV
cat > broker/deploy/.env <<ENV
BROKER_DB_PASSWORD=$(secret)
MARKET_DATA_DB_PASSWORD=$(secret)
SITE_ADDRESS=tradeplatform.dev
SITE_ORIGIN=https://tradeplatform.dev
ENV

install -m 644 hosting/deploy-agent.service hosting/deploy-agent.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now deploy-agent.timer
