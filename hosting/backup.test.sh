#!/usr/bin/env bash
# Checks backup.sh's handling of the exchange's day files, with S3 played by a folder.
#
#     bash hosting/backup.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=hosting/backup.sh
. "$here/backup.sh"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
days=$work/days
s3=$work/s3
mkdir -p "$days" "$s3"
bucket=test-bucket
failed=0

# Stands in for the AWS CLI: `s3 cp <file> s3://bucket/<key>` and `s3api head-object`.
aws() {
  case "$1 $2" in
    "s3 cp")
      mkdir -p "$(dirname "$s3/${4#s3://"$bucket"/}")"
      cp "$3" "$s3/${4#s3://"$bucket"/}"
      ;;
    "s3api head-object")
      local key
      key=$(sed -nE 's/.*--key ([^ ]+).*/\1/p' <<< "$*")
      [ -f "$s3/$key" ]
      ;;
    *) echo "unexpected: aws $*" >&2 && return 1 ;;
  esac
}

check() {
  if eval "$2"; then
    echo "  pass  $1"
  else
    echo "  FAIL  $1"
    failed=1
  fi
}

# Yesterday's finished pair, today's pair being written, a snapshot mid-write, and a
# compressed day from long ago that S3 already has.
printf '{"seq":1}\n%.0s' {1..1000} > "$days/alpha-2026-11-15.1.journal"
cp "$days/alpha-2026-11-15.1.journal" "$work/expected.journal"
echo '{}' > "$days/alpha-2026-11-15.1.snapshot.json"
echo '{"seq":1001}' > "$days/alpha-2026-11-16.1001.journal"
echo '{}' > "$days/alpha-2026-11-16.1001.snapshot.json"
echo '{}' > "$days/alpha-2026-11-17.2000.snapshot.json.tmp"
echo old | gzip > "$days/alpha-2026-11-01.1.journal.gz"
touch -t 202611010000 "$days/alpha-2026-11-01.1.journal.gz"
mkdir -p "$s3/exchange-days"
cp "$days/alpha-2026-11-01.1.journal.gz" "$s3/exchange-days/"

archive_days "$days" > /dev/null

echo "a finished day"
check "is archived, compressed" '[ -f "$s3/exchange-days/alpha-2026-11-15.1.journal.gz" ]'
check "and restores exactly" 'gzip -dc "$s3/exchange-days/alpha-2026-11-15.1.journal.gz" > "$work/restored" && cmp -s "$work/restored" "$work/expected.journal"'
check "its original is deleted" '[ ! -f "$days/alpha-2026-11-15.1.journal" ]'
check "a compressed copy stays" '[ -f "$days/alpha-2026-11-15.1.journal.gz" ]'
check "its snapshot too" '[ -f "$s3/exchange-days/alpha-2026-11-15.1.snapshot.json.gz" ] && [ ! -f "$days/alpha-2026-11-15.1.snapshot.json" ]'
echo "today's day"
check "is left alone" '[ -f "$days/alpha-2026-11-16.1001.journal" ] && [ ! -e "$s3/exchange-days/alpha-2026-11-16.1001.journal.gz" ]'
check "a snapshot being written is left alone" '[ -f "$days/alpha-2026-11-17.2000.snapshot.json.tmp" ]'
echo "an old compressed copy"
check "is removed once past the days kept" '[ ! -f "$days/alpha-2026-11-01.1.journal.gz" ]'

# When S3 does not have it, nothing local is deleted.
echo '{"seq":1}' > "$days/alpha-2026-11-14.1.journal"
aws() { return 1; }
archive_days "$days" > /dev/null 2>&1 || true
echo "S3 unreachable"
check "the original is kept" '[ -f "$days/alpha-2026-11-14.1.journal" ]'
check "and so is every compressed copy" '[ -f "$days/alpha-2026-11-15.1.journal.gz" ]'

# market-data's days of trades: sent as they are, then removed; one being written is not.
trades=$work/trades
mkdir -p "$trades"
echo trades | gzip > "$trades/ticks-2026-11-15.csv.gz"
echo partial > "$trades/ticks-2026-11-16.csv.gz.tmp"
aws() { # reachable again

  case "$1 $2" in
    "s3 cp")
      mkdir -p "$(dirname "$s3/${4#s3://"$bucket"/}")"
      cp "$3" "$s3/${4#s3://"$bucket"/}"
      ;;
    "s3api head-object") [ -f "$s3/$(sed -nE 's/.*--key ([^ ]+).*/\1/p' <<< "$*")" ] ;;
  esac
}
archive_trades "$trades" > /dev/null
echo "a day of trades"
check "is sent unchanged" 'cmp -s "$s3/market-data-trades/ticks-2026-11-15.csv.gz" <(echo trades | gzip)'
check "and removed locally" '[ ! -f "$trades/ticks-2026-11-15.csv.gz" ]'
check "one being written is left alone" '[ -f "$trades/ticks-2026-11-16.csv.gz.tmp" ] && [ ! -e "$s3/market-data-trades/ticks-2026-11-16.csv.gz.tmp" ]'

exit $failed
