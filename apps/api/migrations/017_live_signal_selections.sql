BEGIN;
ALTER TABLE public.live_runs ADD COLUMN IF NOT EXISTS signal_sources text[];
UPDATE public.live_runs SET signal_sources=CASE WHEN signal_source='all'
 THEN ARRAY['fomo_new_project_expanded','top_cluster_first_buy'] ELSE ARRAY[signal_source] END
 WHERE signal_sources IS NULL;
DO $$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='live_runs_signal_sources_valid' AND conrelid='public.live_runs'::regclass) THEN
ALTER TABLE public.live_runs ADD CONSTRAINT live_runs_signal_sources_valid CHECK (
 signal_sources IS NULL OR (cardinality(signal_sources)>0 AND array_position(signal_sources,NULL) IS NULL
 AND signal_sources <@ ARRAY['fomo_new_project_expanded','top_cluster_first_buy','fomo_trending_new_project']::text[])
);
END IF;
END $$;
COMMENT ON COLUMN public.live_runs.signal_sources IS '明确选择的外部信号来源集合；旧任务 all 固定回填原两类，新增来源不自动扩大接入；NULL 仅兼容滚动发布期间旧 API 写入';
COMMENT ON COLUMN public.live_runs.signal_source IS '兼容旧 API 的单来源摘要，多选为 all；实际接入以 signal_sources 为准';
COMMIT;
