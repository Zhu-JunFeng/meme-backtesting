BEGIN;
ALTER TABLE live_runs ADD COLUMN IF NOT EXISTS market_source text;
ALTER TABLE live_runs ADD COLUMN IF NOT EXISTS market_switched_at timestamptz;
ALTER TABLE live_runs ADD COLUMN IF NOT EXISTS market_status jsonb;
COMMENT ON COLUMN live_runs.market_source IS '实时成交来源；meme_market_v2 为 Meme Market 尽力投递协议2；不代表历史补数来源';
COMMENT ON COLUMN live_runs.market_switched_at IS '实时行情源切换时间；不追溯重算历史成交';
COMMENT ON COLUMN live_runs.market_status IS '行情协议、最近消息、订阅及就绪项目数和当前Worker会话数据质量计数';
COMMIT;
