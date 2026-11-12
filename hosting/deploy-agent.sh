#!/usr/bin/env bash
# The server's deploy agent. Runs every minute (deploy-agent.timer) and deploys whatever
# the `live` git tag points at, if that is not what is running already.
#
# GitHub Actions never reaches the server: the deploy workflow builds the images and moves
# `live`; this pulls. So GitHub holds no AWS credentials and the server accepts no inbound
# deploy connections. Rolling back is moving `live` to an older version.
#
# Two steps, so each release is deployed by its own copy of this script:
#
#   1. find:   fetch, and if `live` moved, check out that version.
#   2. deploy: install the server's units, then pull and start every company's stack.
#
# Step 1 replaces this very file, so it ends by running the new copy for step 2 (`exec`,
# with the target and version as arguments). Before this split, a release was deployed by
# the previous release's script: v0.5.0 added the newswire to the list of stacks, and the
# old list ran, so the newswire was never started.
#
# Everything is inside functions, so bash has read the whole script before the checkout
# replaces the file on disk.
set -euo pipefail

REPO=${DEPLOY_REPO:-/opt/trading-platform}            # overridable for testing
STATE=${DEPLOY_STATE:-/var/lib/trading-platform/deployed}
REGISTRY=ghcr.io/snoopy55619819/trading-platform

# Step 1: has `live` moved? If so, check it out and hand over to that version's script.
find_release() {
  cd "$REPO"
  git fetch --quiet --force --tags origin
  local target
  target=$(git rev-parse --verify --quiet 'refs/tags/live^{commit}') || return 0 # nothing released yet
  [ "$(cat "$STATE" 2>/dev/null)" = "$target" ] && return 0

  local version
  version=$(git tag --points-at "$target" | { grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' || true; } | sort -V | tail -n 1)
  if [ -z "$version" ]; then
    echo "live points at $target, which has no version tag; not deploying"
    return 1
  fi

  echo "deploying $version ($target)"
  git checkout --quiet --force --detach "$target"
  exec bash "$REPO/hosting/deploy-agent.sh" --deploy "$target" "$version"
}

# Step 2, run by the script that ships with the release being deployed.
deploy() {
  local target=$1 version=$2
  cd "$REPO"
  install_units
  export IMAGE_PREFIX=$REGISTRY TAG=$version
  # The exchange and the newswire first, then the firms that trade on them, then the broker.
  local stack
  for stack in exchange-alpha/deploy participants/newswire/deploy participants/simulator/deploy broker/deploy; do
    docker compose -f "$stack/compose.yml" pull --quiet
    docker compose -f "$stack/compose.yml" up -d --no-build --remove-orphans
  done
  docker image prune --force > /dev/null

  mkdir -p "$(dirname "$STATE")"
  echo "$target" > "$STATE"
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

if [ "${1:-}" = "--deploy" ]; then
  deploy "$2" "$3"
else
  find_release
fi
