#!/usr/bin/env bash
# The server's deploy agent. Runs every minute (deploy-agent.timer) and deploys whatever
# the `live` git tag points at, if that is not what is running already.
#
# GitHub Actions never reaches the server: the deploy workflow builds the images and moves
# `live`; this pulls. So GitHub holds no AWS credentials and the server accepts no inbound
# deploy connections. Rolling back is moving `live` to an older version.
#
# Everything is inside main(), so bash has read the whole script before the checkout below
# replaces this very file with the new version's copy.
set -euo pipefail

main() {
  local repo=${DEPLOY_REPO:-/opt/trading-platform}            # overridable for testing
  local state=${DEPLOY_STATE:-/var/lib/trading-platform/deployed}
  local registry=ghcr.io/snoopy55619819/trading-platform

  cd "$repo"
  git fetch --quiet --force --tags origin
  local target
  target=$(git rev-parse --verify --quiet 'refs/tags/live^{commit}') || return 0 # nothing released yet
  [ "$(cat "$state" 2>/dev/null)" = "$target" ] && return 0

  local version
  version=$(git tag --points-at "$target" | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } | sort -V | tail -n 1)
  if [ -z "$version" ]; then
    echo "live points at $target, which has no version tag; not deploying"
    return 1
  fi

  echo "deploying $version ($target)"
  git checkout --quiet --force --detach "$target"
  install_units
  export IMAGE_PREFIX=$registry TAG=$version
  # The exchange first, then the firms that trade on it, then the broker.
  local stack
  for stack in exchange-alpha/deploy participants/simulator/deploy broker/deploy; do
    docker compose -f "$stack/compose.yml" pull --quiet
    docker compose -f "$stack/compose.yml" up -d --no-build --remove-orphans
  done
  docker image prune --force > /dev/null

  mkdir -p "$(dirname "$state")"
  echo "$target" > "$state"
  echo "deployed $version"
}

# The server's own jobs ship with each release: this agent, the nightly backup, the hourly
# disk report. Installing them on every deploy means a change to hosting/ needs nothing
# done by hand on the server.
install_units() {
  [ -n "${DEPLOY_REPO:-}" ] && return 0 # a test run: leave the real systemd alone
  install -m 644 hosting/*.service hosting/*.timer /etc/systemd/system/
  systemctl daemon-reload
  local timer
  for timer in hosting/*.timer; do
    systemctl enable --now "$(basename "$timer")" > /dev/null 2>&1
  done
}

main "$@"
