#!/usr/bin/env bash

set -u

CLASH_BIN="${CLASH_BIN:-/usr/bin/clash-verge}"
CC_SWITCH_BIN="${CC_SWITCH_BIN:-/usr/bin/cc-switch}"
CLASH_PROXY_PORT="${CLASH_LIFECYCLE_PROXY_PORT:-7897}"

# Start Clash first so CC Switch never resolves upstream APIs through an
# unavailable Fake-IP DNS/TUN stack.
if ! pgrep -x clash-verge >/dev/null 2>&1; then
    "$CLASH_BIN" >/dev/null 2>&1 &
fi

# Wait up to 45 seconds for Clash's mixed proxy port. Continue afterwards so
# CC Switch remains available even when Clash itself needs attention.
attempt=0
while [ "$attempt" -lt 45 ]; do
    if ss -H -ltn "sport = :$CLASH_PROXY_PORT" 2>/dev/null | grep -q .; then
        break
    fi
    attempt=$((attempt + 1))
    sleep 1
done

if ! pgrep -x cc-switch >/dev/null 2>&1; then
    "$CC_SWITCH_BIN" >/dev/null 2>&1 &
fi
