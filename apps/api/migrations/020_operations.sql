BEGIN;
CREATE TABLE operations_metric_samples (id bigserial PRIMARY KEY, source text NOT NULL, sampled_at timestamptz NOT NULL DEFAULT now(), metrics jsonb NOT NULL);
CREATE INDEX operations_metric_samples_source_time ON operations_metric_samples(source,sampled_at DESC);
COMMENT ON TABLE operations_metric_samples IS '分钟级运维汇总，保留七天，不保存项目明细或凭据';
COMMENT ON COLUMN operations_metric_samples.id IS '采样记录主键';
COMMENT ON COLUMN operations_metric_samples.source IS '采样来源：api或worker';
COMMENT ON COLUMN operations_metric_samples.sampled_at IS '采样时间';
COMMENT ON COLUMN operations_metric_samples.metrics IS '脱敏运行状态与轻量指标';
COMMIT;
