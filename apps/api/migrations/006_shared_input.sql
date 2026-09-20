ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS input_source_run_id uuid REFERENCES backtest_runs(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS backtest_runs_input_source ON backtest_runs(input_source_run_id) WHERE input_source_run_id IS NOT NULL;
COMMENT ON COLUMN backtest_runs.input_source_run_id IS '共享只读冻结行情的原始任务；空值使用自身输入，禁止引用链';
CREATE OR REPLACE FUNCTION protect_shared_input_rows() RETURNS trigger AS $$
DECLARE owner_id uuid;
BEGIN
 owner_id := CASE WHEN TG_OP='INSERT' THEN NEW.run_id ELSE OLD.run_id END;
 PERFORM 1 FROM backtest_runs WHERE id=owner_id AND input_ready FOR UPDATE;
 IF EXISTS(SELECT 1 FROM backtest_runs WHERE input_source_run_id=owner_id) THEN
  RAISE EXCEPTION '共享冻结输入禁止修改或清理';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE' AND NEW.run_id<>OLD.run_id THEN RAISE EXCEPTION '冻结输入不允许移动到其他任务'; END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS shared_input_chunks_guard ON backtest_input_chunks;
CREATE TRIGGER shared_input_chunks_guard BEFORE INSERT OR UPDATE OR DELETE ON backtest_input_chunks FOR EACH ROW EXECUTE FUNCTION protect_shared_input_rows();
DROP TRIGGER IF EXISTS shared_input_pools_guard ON backtest_input_pools;
CREATE TRIGGER shared_input_pools_guard BEFORE INSERT OR UPDATE OR DELETE ON backtest_input_pools FOR EACH ROW EXECUTE FUNCTION protect_shared_input_rows();
CREATE OR REPLACE FUNCTION validate_shared_input_run() RETURNS trigger AS $$
DECLARE source backtest_runs;
BEGIN
 IF TG_OP='UPDATE' AND OLD.input_source_run_id IS DISTINCT FROM NEW.input_source_run_id THEN RAISE EXCEPTION '共享输入来源不可修改'; END IF;
 IF TG_OP='UPDATE' AND (OLD.input_source_run_id IS DISTINCT FROM NEW.input_source_run_id OR OLD.config_json IS DISTINCT FROM NEW.config_json OR OLD.input_ready IS DISTINCT FROM NEW.input_ready) THEN
  IF OLD.input_source_run_id IS NOT NULL OR EXISTS(SELECT 1 FROM backtest_runs WHERE input_source_run_id=OLD.id) THEN RAISE EXCEPTION '共享输入任务配置与来源不可修改'; END IF;
 END IF;
 IF NEW.input_source_run_id IS NOT NULL AND TG_OP='INSERT' THEN
  SELECT * INTO source FROM backtest_runs WHERE id=NEW.input_source_run_id FOR UPDATE;
  IF source.id IS NULL OR NOT source.input_ready OR source.status<>'completed' OR source.input_source_run_id IS NOT NULL OR NOT NEW.input_ready THEN RAISE EXCEPTION '共享来源必须为已完成的原始冻结任务'; END IF;
  IF (NEW.config_json->'symbols') IS DISTINCT FROM (source.config_json->'symbols') OR (NEW.config_json->'pools') IS DISTINCT FROM (source.config_json->'pools') OR (NEW.config_json->'interval') IS DISTINCT FROM (source.config_json->'interval') OR (NEW.config_json->'valueType') IS DISTINCT FROM (source.config_json->'valueType') OR (NEW.config_json->'startTime') IS DISTINCT FROM (source.config_json->'startTime') OR (NEW.config_json->'endTime') IS DISTINCT FROM (source.config_json->'endTime') THEN RAISE EXCEPTION '共享输入数据集不一致'; END IF;
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS shared_input_run_guard ON backtest_runs;
CREATE TRIGGER shared_input_run_guard BEFORE INSERT OR UPDATE ON backtest_runs FOR EACH ROW EXECUTE FUNCTION validate_shared_input_run();
