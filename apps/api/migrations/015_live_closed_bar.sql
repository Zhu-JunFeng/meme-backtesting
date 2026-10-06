BEGIN;
ALTER TABLE live_runs ADD COLUMN IF NOT EXISTS execution_version text NOT NULL DEFAULT 'tick-v1';
ALTER TABLE live_runs ADD COLUMN IF NOT EXISTS execution_switched_at timestamptz;
COMMENT ON COLUMN live_runs.execution_version IS '实时执行规则版本；closed-bar-v2 为完整K线收盘后决策及模拟撮合';
COMMENT ON COLUMN live_runs.execution_switched_at IS '切换收盘执行规则的时间；之前历史成交不重算';
COMMENT ON COLUMN live_fills.fill_time IS '实盘为真实成交时间；收盘规则模拟盘为依据K线的收盘时间，Unix毫秒';
COMMENT ON COLUMN live_fills.fill_price IS '实盘为已核实成交代币价格；模拟盘为撮合参考价格，市值策略换算依据保存在raw_result';
COMMENT ON COLUMN live_fills.market_cap IS '实盘为成交时可信市值；模拟盘市值策略为K线撮合参考市值，非真实链上成交';
COMMIT;
