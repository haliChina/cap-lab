#!/usr/bin/env bash
# capcheck — 看一眼你的 Cap 部署处在哪一代、开了哪些防护。
# 只发 1 次 challenge 请求，不 redeem、不尝试通过验证。
#
#   ./capcheck.sh <baseUrl> [capApiPrefix]
#   ./capcheck.sh http://127.0.0.1:3010 /
set -u
BASE=${1:-}
API=${2:-/api/cap/}
[ -z "$BASE" ] && { echo "usage: capcheck.sh <baseUrl> [capApiPrefix]"; exit 1; }

echo "target: ${BASE}${API}challenge"
BODY=$(curl -s -m 20 -X POST "${BASE}${API}challenge" -w '\n__HTTP__%{http_code}' 2>/dev/null)
CODE=$(printf '%s' "$BODY" | tail -1 | sed 's/__HTTP__//')
JSON=$(printf '%s' "$BODY" | sed '$d')

echo "http: $CODE"
if [ "$CODE" != "200" ]; then
  echo "-> 端点没响应 200，前端可能用了别的前缀。翻页面里 Cap 的 apiEndpoint 拿到准确路径再试。"
  exit 1
fi

# NB: mktemp may hand back a host-side path that isn't visible inside the
# sandbox, so use a plain file in /tmp instead.
TMP="/tmp/capcheck.$$.json"
printf '%s' "$JSON" > "$TMP"
DIR=$(dirname "$0")
python3 "$DIR/capcheck.py" "$TMP"
rm -f "$TMP"
