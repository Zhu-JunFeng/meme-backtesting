#!/bin/sh
set -eu
# Also held by release.sh while replacing containers. Database advisory locks
# remain authoritative against manual CLI invocations and other hosts.
exec 9>/run/lock/meme-backtest-batch.lock
flock -n 9 || exit 0
[ "$(docker inspect -f '{{.State.Running}}' meme-backtesting-api 2>/dev/null)" = true ] || exit 0
pg_container=$(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /postgres|timescale/ {print $1}')
[ "$(printf '%s\n' "$pg_container" | wc -l)" -eq 1 ] && [ -n "$pg_container" ] || {
  echo '无法唯一识别数据库容器，禁止估算容量' >&2
  exit 1
}
free=$(docker exec "$pg_container" sh -c 'df -Pk "${PGDATA:-/var/lib/postgresql/data}"' | awk 'NR==2 {printf "%.0f",$4*1024}')
case "$free" in ''|*[!0-9]*) echo '数据库卷容量无效' >&2; exit 1;; esac
# advance never starts an unapproved batch or resumes a paused batch.
docker exec -e BACKTEST_CLI=1 -e BATCH_FREE_BYTES="$free" meme-backtesting-api node apps/api/dist/batch-cli.js advance --yes
