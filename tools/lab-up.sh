#!/bin/sh
# Start redis + cap standalone, detached, and wait until healthy.
# Everything is idempotent: safe to call before every matrix phase.
set -e
LAB=$(dirname "$0")
PORT=${PORT:-3010}

redis-cli ping >/dev/null 2>&1 || {
  redis-server --port 6379 --save '' --appendonly no --daemonize yes
  sleep 2
}

if ! curl -sf -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  CAP_DIR=${CAP_DIR:-$LAB/../cap/standalone}
  cd "$CAP_DIR"
  ADMIN_KEY=${ADMIN_KEY:-change-me-local-lab-key} \
  REDIS_URL=redis://127.0.0.1:6379 \
  SERVER_PORT=$PORT \
  SERVER_HOSTNAME=0.0.0.0 \
  ENABLE_ASSETS_SERVER=true \
  setsid nohup /opt/bun/bun run ./src/index.js > /tmp/cap.log 2>&1 < /dev/null &
fi

i=0
while [ $i -lt 40 ]; do
  if curl -sf -m 3 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "lab up on $PORT"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done
echo "lab failed to start" >&2
tail -5 /tmp/cap.log >&2
exit 1