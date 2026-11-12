#!/usr/bin/env bash
# Nightly backups (backup.timer, 22:30 UTC, after the exchange's 21:00 business-day roll).
#
# 1. Dumps each of the three databases to S3, gzipped. A bucket rule deletes them after
#    30 days.
# 2. Archives the exchange's finished day files (every snapshot and journal except the
#    current day's pair) to S3, gzipped, then deletes local copies that are archived and
#    more than a week old. The gateway only ever reads the newest pair, and never deletes
#    anything itself, so without this the disk would fill.
# 3. Reports that it finished, so a missed night raises an alarm.
#
# Settings: /etc/trading-platform/aws.env (BACKUP_BUCKET, AWS_REGION). The server reaches
# S3 and CloudWatch through its instance role: there are no keys on it.
set -euo pipefail

main() {
  local settings=${AWS_SETTINGS:-/etc/trading-platform/aws.env} # overridable for testing
  if [ ! -f "$settings" ]; then
    echo "no $settings: backups are not set up on this server"
    return 0
  fi
  # shellcheck source=/dev/null
  . "$settings"
  export AWS_REGION
  bucket=${BACKUP_BUCKET:?BACKUP_BUCKET is not set in $settings}
  repo=${DEPLOY_REPO:-/opt/trading-platform}
  local days=${EXCHANGE_DAYS:-/var/lib/docker/volumes/exchange-alpha-deploy_days/_data}
  today=$(date -u +%F)

  dump exchange-alpha/deploy postgres exchange_alpha exchange
  dump broker/deploy postgres broker broker
  dump broker/deploy market-data-postgres market_data market-data

  archive_days "$days"

  aws cloudwatch put-metric-data --namespace TradingPlatform --metric-name BackupCompleted \
    --dimensions Server=trading-platform --value 1 --unit Count
  echo "backup complete"
}

# A database, dumped by its own container to s3://<bucket>/databases/<date>/<name>.sql.gz.
dump() {
  local stack=$1 service=$2 user=$3 name=$4
  docker compose -f "$repo/$stack/compose.yml" exec -T "$service" pg_dump --username "$user" "$user" \
    | gzip \
    | aws s3 cp - "s3://$bucket/databases/$today/$name.sql.gz" --only-show-errors
  echo "dumped $name"
}

# Day files are alpha-<date>.<first seq>.snapshot.json and .journal; the highest first seq
# is the day being written now.
archive_days() {
  local dir=$1 current file name seq key
  current=$( (ls "$dir" 2> /dev/null || true) \
    | sed -nE 's/^alpha-[0-9-]+\.([0-9]+)\.snapshot\.json$/\1/p' | sort -n | tail -n 1)
  for file in "$dir"/alpha-*; do
    [ -f "$file" ] || continue
    name=$(basename "$file")
    case $name in *.tmp) continue ;; esac # a snapshot being written
    seq=$(sed -nE 's/^alpha-[0-9-]+\.([0-9]+)\..*$/\1/p' <<< "$name")
    [ -n "$seq" ] && [ "$seq" != "$current" ] || continue
    key=exchange-days/$name.gz
    if ! aws s3api head-object --bucket "$bucket" --key "$key" > /dev/null 2>&1; then
      gzip -c "$file" | aws s3 cp - "s3://$bucket/$key" --only-show-errors
      echo "archived $name"
    fi
    # Only what is safely archived, and only after a week, in case it is needed quickly.
    if [ -n "$(find "$file" -mtime +7)" ] \
      && aws s3api head-object --bucket "$bucket" --key "$key" > /dev/null 2>&1; then
      rm -f "$file"
      echo "removed local $name"
    fi
  done
}

main "$@"
