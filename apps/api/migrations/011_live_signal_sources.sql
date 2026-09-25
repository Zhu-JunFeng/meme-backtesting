BEGIN;
ALTER TABLE public.live_runs ADD COLUMN IF NOT EXISTS signal_source text NOT NULL DEFAULT 'all';
ALTER TABLE public.live_runs ADD COLUMN IF NOT EXISTS client_key text;
CREATE UNIQUE INDEX IF NOT EXISTS live_runs_client_key_unique ON public.live_runs(client_key) WHERE client_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS live_runs_source_running ON public.live_runs(chain,signal_source,started_at) WHERE status='running';
COMMENT ON COLUMN public.live_runs.signal_source IS '纳入任务的外部信号来源；all 仅为旧任务及兼容调用保留';
COMMENT ON COLUMN public.live_runs.client_key IS '创建模拟盘任务的幂等键，重复提交不得产生第二个任务';
COMMIT;
