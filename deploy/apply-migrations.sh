#!/bin/sh
set -eu
: "${DATABASE_URL:?DATABASE_URL is required}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "COMMENT ON TABLE public.schema_migrations IS '已完成的数据库迁移，避免发布时重复执行历史全表更新'"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "COMMENT ON COLUMN public.schema_migrations.name IS '迁移文件名称'"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "COMMENT ON COLUMN public.schema_migrations.applied_at IS '首次成功执行或基线确认时间'"

# Existing installations predate the ledger. Migration 013 was transactional;
# its distinctive columns prove the earlier numbered migrations were released.
legacy_complete=$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT
    EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='live_runs' AND column_name='dropped_trade_count')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='live_orders' AND column_name='reconcile_checked_at')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='live_watches' AND column_name='recovery_reason')")
if [ "$legacy_complete" = t ]; then
  echo '已核对旧版迁移 013 结构，建立 001–013 基线；不会重跑历史全表修正。'
  for migration in apps/api/migrations/*.sql; do
    name=${migration##*/}
    case "$name" in *[!a-zA-Z0-9_.-]*) echo "非法迁移文件名：$name" >&2; exit 1;; esac
    version=${name%%_*}
    if [ "$version" -le 13 ]; then
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO public.schema_migrations(name) VALUES('$name') ON CONFLICT DO NOTHING"
    fi
  done
fi

for migration in apps/api/migrations/*.sql; do
  name=${migration##*/}
  case "$name" in *[!a-zA-Z0-9_.-]*) echo "非法迁移文件名：$name" >&2; exit 1;; esac
  applied=$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM public.schema_migrations WHERE name='$name'")
  if [ "$applied" = 0 ]; then
    echo "执行数据库迁移：$name"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO public.schema_migrations(name) VALUES('$name') ON CONFLICT DO NOTHING"
  fi
done
