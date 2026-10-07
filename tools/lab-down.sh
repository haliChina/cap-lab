#!/bin/sh
# Stop cap + redis started by lab-up.sh (match by cmdline, never by pattern on self).
self=$$
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  [ "$pid" = "$self" ] && continue
  cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
  case "$cmd" in
    "/opt/bun/bun run ./src/index.js"*) kill "$pid" 2>/dev/null && echo "stopped cap $pid" ;;
  esac
done
sleep 1
redis-cli shutdown nosave >/dev/null 2>&1 && echo "stopped redis"
exit 0