#!/bin/sh
set -eu
# Called in the checked-out release directory. Never silently take over legacy jobs.
legacy_count() {
docker run --rm --network host --env-file deploy/.env postgres:18-alpine sh -c 'psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM backtest_runs r WHERE status IN ('"'"'pending'"'"','"'"'running'"'"') AND to_jsonb(r)->>'"'"'runtime_version'"'"' IS NULL"'
}
legacy=$(legacy_count)
if [ "$legacy" != "0" ]; then
  echo "发布暂停：存在 $legacy 个无检查点的旧任务。请先盘点并明确处理，不自动重新执行。"
  exit 1
fi
docker run --rm --network host --env-file deploy/.env -v "$PWD:/app" -w /app postgres:18-alpine sh -ec 'for migration in apps/api/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"; done'
docker build -f deploy/Dockerfile.api -t meme-backtesting-api .
docker build -f deploy/Dockerfile.worker -t meme-backtesting-worker .
docker build -f deploy/Dockerfile.web -t meme-backtesting-web .
# Wait for any in-flight coordinator transaction before replacing the API.
# The timer remains enabled; ticks during this critical section safely skip.
exec 9>/run/lock/meme-backtest-batch.lock
flock -w 900 9
# Close admission before the final legacy check; jobs may have arrived during image builds.
if docker inspect meme-backtesting-api >/dev/null 2>&1; then docker stop --time 90 meme-backtesting-api; fi
legacy=$(legacy_count)
if [ "$legacy" != "0" ]; then
  docker start meme-backtesting-api
  echo "发布暂停：构建期间新增了旧版任务，已恢复原 API；Worker 未停止。"
  exit 1
fi
# Grace period lets the executor finish one timestamp and atomically checkpoint before exit.
for service in meme-backtesting-worker meme-backtesting-api meme-backtesting-web; do
  if docker inspect "$service" >/dev/null 2>&1; then docker stop --time 90 "$service"; docker rm "$service"; fi
done
docker run -d --name meme-backtesting-api --restart unless-stopped --network host --env-file deploy/.env -e NODE_ENV=production -e BACKTEST_QUEUE_PREFIX=meme-production-v3 meme-backtesting-api:latest
docker run -d --name meme-backtesting-worker --restart unless-stopped --stop-timeout 90 --network host --env-file deploy/.env -e NODE_ENV=production -e BACKTEST_QUEUE_PREFIX=meme-production-v3 meme-backtesting-worker:latest
docker run -d --name meme-backtesting-web --restart unless-stopped --network host meme-backtesting-web:latest
sh deploy/install-batch-timer.sh
flock -u 9
# Start a first check now instead of waiting for the timer after deployment.
systemctl start --no-block meme-backtest-batch.service
