BEGIN;
ALTER TABLE public.live_runs ADD COLUMN IF NOT EXISTS feed_state text NOT NULL DEFAULT 'paused';
ALTER TABLE public.live_runs ALTER COLUMN feed_state SET DEFAULT 'paused';
ALTER TABLE public.live_runs ADD COLUMN IF NOT EXISTS feed_reason text;
ALTER TABLE public.live_runs ADD COLUMN IF NOT EXISTS execution_hold_reason text;
ALTER TABLE public.live_runs ADD COLUMN IF NOT EXISTS reconnect_count bigint NOT NULL DEFAULT 0;
ALTER TABLE public.live_runs ADD COLUMN IF NOT EXISTS late_trade_count bigint NOT NULL DEFAULT 0;
ALTER TABLE public.live_runs ADD COLUMN IF NOT EXISTS dropped_trade_count bigint NOT NULL DEFAULT 0;
ALTER TABLE public.live_runs ADD COLUMN IF NOT EXISTS last_signal_at bigint;
ALTER TABLE public.live_runs ADD COLUMN IF NOT EXISTS last_trade_at bigint;
COMMENT ON COLUMN public.live_runs.feed_state IS '实时行情连接状态：连接中、补行情、正常或故障重试';
COMMENT ON COLUMN public.live_runs.feed_reason IS '最近行情恢复或故障原因';
COMMENT ON COLUMN public.live_runs.execution_hold_reason IS '实盘订单结果未知时冻结新订单的原因';
COMMENT ON COLUMN public.live_runs.reconnect_count IS '行情 Socket.IO 重连次数';
COMMENT ON COLUMN public.live_runs.late_trade_count IS '接收的乱序成交数量';
COMMENT ON COLUMN public.live_runs.dropped_trade_count IS '过旧或已收盘成交丢弃数量';
COMMENT ON COLUMN public.live_runs.last_signal_at IS '最近有效外部信号时间，Unix 毫秒';
COMMENT ON COLUMN public.live_runs.last_trade_at IS '最近有效实时成交时间，Unix 毫秒';
ALTER TABLE public.live_watches ADD COLUMN IF NOT EXISTS current_mcap numeric;
ALTER TABLE public.live_watches ADD COLUMN IF NOT EXISTS mcap_checked_at timestamptz;
ALTER TABLE public.live_watches ADD COLUMN IF NOT EXISTS last_trade_at bigint;
ALTER TABLE public.live_watches ADD COLUMN IF NOT EXISTS recovery_reason text;
COMMENT ON COLUMN public.live_watches.current_mcap IS '最近可信美元市值，用于五万美元监控门槛';
COMMENT ON COLUMN public.live_watches.mcap_checked_at IS '最近一次 MemeInfo 市值复查时间';
COMMENT ON COLUMN public.live_watches.last_trade_at IS '最近有效实时成交时间，Unix 毫秒';
COMMENT ON COLUMN public.live_watches.recovery_reason IS '池级连接、补行情或剔除原因';
CREATE INDEX IF NOT EXISTS live_watches_capacity ON public.live_watches(run_id,status);
ALTER TABLE public.live_orders DROP CONSTRAINT IF EXISTS live_orders_status_check;
ALTER TABLE public.live_orders ADD CONSTRAINT live_orders_status_check CHECK(status IN ('pending','submitted','filled','failed','unknown','cancelled'));
ALTER TABLE public.live_orders ADD COLUMN IF NOT EXISTS reconcile_checked_at timestamptz;
COMMENT ON COLUMN public.live_orders.status IS '待提交、已提交、已成交、失败、结果未知或取消';
COMMENT ON COLUMN public.live_orders.reconcile_checked_at IS '最近一次查询 XXYY 交易和钱包状态的时间';
UPDATE public.live_runs r SET status='running',feed_state='recovering',feed_reason='旧版待人工处理任务自动补行情恢复',error_message=NULL,updated_at=now()
 WHERE r.status='attention' AND r.mode='paper'
 AND NOT EXISTS(SELECT 1 FROM public.live_orders o WHERE o.run_id=r.id AND o.status IN ('pending','submitted','unknown'))
 AND NOT EXISTS(SELECT 1 FROM public.live_watches w WHERE w.run_id=r.id AND w.state_json ? 'position' AND w.state_json->'position'<>'null'::jsonb);
UPDATE public.live_runs SET status='paused',feed_state='paused',feed_reason='旧版待人工处理任务需检查持仓或订单',updated_at=now()
 WHERE status='attention';
UPDATE public.live_runs SET feed_state='paused' WHERE status IN ('paused','stopped') AND feed_state='connecting';
UPDATE public.live_runs SET feed_state='connecting' WHERE status='running' AND feed_state='paused';
ALTER TABLE public.live_runs DROP CONSTRAINT IF EXISTS live_runs_status_check;
ALTER TABLE public.live_runs ADD CONSTRAINT live_runs_status_check CHECK(status IN ('paused','running','stopped'));
COMMENT ON COLUMN public.live_runs.status IS '任务状态：暂停、运行或已停止；行情恢复独立展示';
COMMIT;
