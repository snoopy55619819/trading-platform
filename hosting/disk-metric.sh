#!/usr/bin/env bash
# Hourly (disk-metric.timer): reports how full the server's disk is to CloudWatch, where an
# alarm emails when it passes 80%, or when the reports stop. Settings as for backup.sh.
set -euo pipefail

main() {
  local settings=${AWS_SETTINGS:-/etc/trading-platform/aws.env}
  [ -f "$settings" ] || return 0
  # shellcheck source=/dev/null
  . "$settings"
  export AWS_REGION
  local used
  used=$(df --output=pcent / | tail -n 1 | tr -dc '0-9')
  aws cloudwatch put-metric-data --namespace TradingPlatform --metric-name DiskUsedPercent \
    --dimensions Server=trading-platform --value "$used" --unit Percent
}

main "$@"
