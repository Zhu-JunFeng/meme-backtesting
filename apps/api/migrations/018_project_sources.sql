BEGIN;
ALTER TABLE live_runs ADD COLUMN IF NOT EXISTS project_sources jsonb;
ALTER TABLE live_runs ADD COLUMN IF NOT EXISTS source_status jsonb NOT NULL DEFAULT '{}';
ALTER TABLE live_runs ADD COLUMN IF NOT EXISTS source_activated_at jsonb NOT NULL DEFAULT '{}';
COMMENT ON COLUMN live_runs.source_activated_at IS '后续启用来源的生效毫秒时间，防止接收启用前钱包交易';
ALTER TABLE live_watches ADD COLUMN IF NOT EXISTS matched_sources text[] NOT NULL DEFAULT ARRAY['memeinfo'];
ALTER TABLE live_watches ADD COLUMN IF NOT EXISTS exit_market_cap numeric NOT NULL DEFAULT 50000;
ALTER TABLE live_watches ADD COLUMN IF NOT EXISTS admitted_at bigint;
ALTER TABLE live_watches ADD COLUMN IF NOT EXISTS exit_only boolean NOT NULL DEFAULT false;
UPDATE live_watches SET exit_only=true WHERE status='pending_eviction';
COMMENT ON COLUMN live_watches.exit_only IS '低市值触发后只允许退出；断线恢复保留，重新入组才清除';
COMMENT ON COLUMN live_runs.project_sources IS '版本化项目来源与入组／剔除规则；空值兼容原 MemeInfo 来源，不自动开启新来源';
COMMENT ON COLUMN live_runs.source_status IS '项目发现来源独立健康状态、最近成功时间及计数，不代表成交行情健康';
COMMENT ON COLUMN live_watches.matched_sources IS '本轮实际匹配的来源类别，剔除门槛取这些来源中的最低值';
COMMENT ON COLUMN live_watches.exit_market_cap IS '当前有效剔除市值，单位 USD，配置更新后同步';
COMMENT ON COLUMN live_watches.admitted_at IS '本轮接收项目的 Unix 毫秒时间，重新入组时更新';
CREATE TABLE IF NOT EXISTS live_source_cursors (
 source_key text PRIMARY KEY, state_json jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE live_source_cursors IS '项目发现来源持久化扫描游标，单一实时服务租约内使用';
COMMENT ON COLUMN live_source_cursors.source_key IS '来源及钱包的唯一游标键';
COMMENT ON COLUMN live_source_cursors.state_json IS '已完整处理交易游标及分页恢复状态，不含密钥';
COMMENT ON COLUMN live_source_cursors.updated_at IS '游标最后成功保存时间';
CREATE TABLE IF NOT EXISTS live_source_receipts (
 event_key text PRIMARY KEY, provider text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, retry_at timestamptz
);
CREATE INDEX IF NOT EXISTS live_source_receipts_pending ON live_source_receipts(created_at) WHERE processed_at IS NULL;
COMMENT ON TABLE live_source_receipts IS '项目来源持久化收件箱，先落库后消费，重启不丢失或重复接收';
COMMENT ON COLUMN live_source_receipts.event_key IS '钱包交易／列表发现唯一身份';
COMMENT ON COLUMN live_source_receipts.provider IS '项目来源类别';
COMMENT ON COLUMN live_source_receipts.payload IS '规范化项目发现信息和原始触发身份，不含密钥';
COMMENT ON COLUMN live_source_receipts.created_at IS '首次发现并保存时间';
COMMENT ON COLUMN live_source_receipts.processed_at IS '准入检查完成时间；空值等待重试';
COMMENT ON COLUMN live_source_receipts.retry_at IS '单项失败后的重试时间，不阻塞其他项';
COMMIT;
