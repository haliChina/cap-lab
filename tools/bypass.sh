#!/bin/sh
# One-command demo against the local lab: bring the target up, create the
# strictest site key, mint a token without a browser, verify it.
set -e
LAB=$(dirname "$0")
sh "$LAB/lab-up.sh" >/dev/null
exec node "$LAB/oneclick.mjs" --base http://127.0.0.1:3010 --admin "${ADMIN_KEY:?set ADMIN_KEY to your instance admin key}" --create "${1:-strict}" --rounds "${2:-1}"