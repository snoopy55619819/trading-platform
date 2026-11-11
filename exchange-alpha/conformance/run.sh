#!/usr/bin/env bash
# QuickFIX conformance for Alpha Exchange.
#
# An independent FIX engine (QuickFIX/Go) trades through the gateway, then the gateway is
# killed with SIGKILL mid-session and restarted. The book must survive, sequence numbers must
# resume, and a fill that happened while a client was away must reach it by resend.
#
# Needs the exchange database:  docker compose -f compose.yml up -d --wait
# Run from exchange-alpha/:     ./conformance/run.sh

set -euo pipefail
cd "$(dirname "$0")"

ADDR=127.0.0.1:9878
WORK=$(mktemp -d)
export ALPHA_JOURNAL="$WORK/alpha.journal"
GATEWAY_PID=""

stop_gateway() { [ -n "$GATEWAY_PID" ] && kill "$GATEWAY_PID" 2>/dev/null; wait "$GATEWAY_PID" 2>/dev/null || true; }
trap stop_gateway EXIT

if lsof -ti "tcp:${ADDR##*:}" >/dev/null 2>&1; then
  echo "something is already listening on $ADDR; stop it first" >&2
  exit 1
fi

start_gateway() {
  ../target/debug/gateway >>"$WORK/gateway.log" 2>&1 &
  GATEWAY_PID=$!
  for _ in $(seq 1 50); do
    nc -z "${ADDR%:*}" "${ADDR##*:}" 2>/dev/null && return 0
    sleep 0.2
  done
  echo "gateway did not start; log follows" >&2
  cat "$WORK/gateway.log" >&2
  exit 1
}

echo "== fresh state: new journal, empty session tables, empty QuickFIX store"
docker exec exchange-alpha-postgres psql -U exchange_alpha -d exchange_alpha -qc \
  "DROP TABLE IF EXISTS fix_outbound, fix_sessions, _sqlx_migrations" >/dev/null
rm -rf .store
(cd .. && cargo build -q -p gateway)
start_gateway

echo; echo "== trade";   go run . trade
echo; echo "== rest";    go run . rest

echo; echo "== kill -9 the gateway, then restart it on the same journal and database"
kill -9 "$GATEWAY_PID"
wait "$GATEWAY_PID" 2>/dev/null || true
start_gateway
grep -o 'recovered from journal.*' "$WORK/gateway.log" | tail -1 | sed 's/\x1b\[[0-9;]*m//g'

echo; echo "== take";    go run . take
echo; echo "== collect"; go run . collect

echo; echo "conformance passed. gateway log: $WORK/gateway.log"
