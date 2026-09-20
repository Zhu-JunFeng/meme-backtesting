ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS runtime_version text;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS queue_scope text;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'legacy';
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS execution_epoch integer NOT NULL DEFAULT 0;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS checkpoint_at timestamptz;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS recovery_count integer NOT NULL DEFAULT 0;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS failure_streak integer NOT NULL DEFAULT 0;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS dispatch_no integer NOT NULL DEFAULT 0;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS input_ready boolean NOT NULL DEFAULT false;
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS parent_run_id uuid REFERENCES backtest_runs(id);
CREATE TABLE IF NOT EXISTS backtest_input_chunks (
 run_id uuid NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
 pool_key text NOT NULL, chunk_no integer NOT NULL, candles_json jsonb NOT NULL,
 PRIMARY KEY(run_id,pool_key,chunk_no)
);
CREATE TABLE IF NOT EXISTS backtest_input_pools (
 run_id uuid NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
 pool_key text NOT NULL, symbol_json jsonb NOT NULL, chunk_count integer NOT NULL,
 candle_count integer NOT NULL, normalized_count bigint NOT NULL, invalid_count integer NOT NULL,
 PRIMARY KEY(run_id,pool_key)
);
CREATE TABLE IF NOT EXISTS backtest_checkpoints (
 run_id uuid PRIMARY KEY REFERENCES backtest_runs(id) ON DELETE CASCADE,
 batch_no integer NOT NULL, config_checksum text NOT NULL, state_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS backtest_result_batches (
 run_id uuid NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
 batch_no integer NOT NULL, execution_epoch integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,batch_no)
);
CREATE TABLE IF NOT EXISTS backtest_rerun_requests (
 request_id uuid PRIMARY KEY, source_run_id uuid NOT NULL REFERENCES backtest_runs(id), new_run_id uuid NOT NULL REFERENCES backtest_runs(id)
);
CREATE INDEX IF NOT EXISTS backtest_runs_recovery ON backtest_runs(queue_scope,status,lease_until) WHERE runtime_version IS NOT NULL;
COMMENT ON COLUMN backtest_runs.runtime_version IS '执行协议版本；空值为未支持断点的历史任务，不自动接管';
COMMENT ON COLUMN backtest_runs.status IS '状态：pending 等待、running 执行、stopping 停止中、stopped 已停止、completed 完成、failed 失败；cancelled 为历史取消状态';
COMMENT ON COLUMN backtest_runs.queue_scope IS '任务执行环境隔离标识';
COMMENT ON COLUMN backtest_runs.phase IS '执行阶段：legacy、freezing、computing、saving、completed';
COMMENT ON COLUMN backtest_runs.execution_epoch IS '递增执行代次，阻止失去租约的执行器写入';
COMMENT ON COLUMN backtest_runs.heartbeat_at IS '最近执行心跳时间';
COMMENT ON COLUMN backtest_runs.lease_until IS '执行租约到期时间';
COMMENT ON COLUMN backtest_runs.checkpoint_at IS '最近原子提交的检查点时间';
COMMENT ON COLUMN backtest_runs.recovery_count IS '异常或发布后的恢复次数';
COMMENT ON COLUMN backtest_runs.failure_streak IS '连续异常恢复次数，成功检查点后归零';
COMMENT ON COLUMN backtest_runs.dispatch_no IS '队列投递序号，用于幂等补投递';
COMMENT ON COLUMN backtest_runs.input_ready IS '冻结输入是否全部完成；完成前不计算';
COMMENT ON COLUMN backtest_runs.parent_run_id IS '重新回测的来源任务';
COMMENT ON TABLE backtest_input_chunks IS '回测冻结行情分块；恢复不读取可变行情源';
COMMENT ON TABLE backtest_input_pools IS '冻结交易池完整性清单和工作量统计';
COMMENT ON TABLE backtest_checkpoints IS '引擎与输入游标检查点，与阶段结果原子提交';
COMMENT ON TABLE backtest_result_batches IS '已提交结果批次，防止恢复重复写入';
COMMENT ON TABLE backtest_rerun_requests IS '重新回测请求幂等映射';
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('backtest_input_chunks','backtest_input_pools','backtest_checkpoints','backtest_result_batches','backtest_rerun_requests') LOOP
 EXECUTE format('COMMENT ON COLUMN public.%I.%I IS %L',item.table_name,item.column_name,
 CASE item.column_name WHEN 'run_id' THEN '所属回测任务' WHEN 'pool_key' THEN '链、合约和交易池复合标识' WHEN 'chunk_no' THEN '行情分块序号，从零开始' WHEN 'candles_json' THEN '冻结的有效 OHLCV 行情数组' WHEN 'symbol_json' THEN '交易池身份快照' WHEN 'chunk_count' THEN '冻结行情分块总数' WHEN 'candle_count' THEN '有效原始 K 线数' WHEN 'normalized_count' THEN '包含惰性补齐时间桶的计算总量' WHEN 'invalid_count' THEN '清洗时跳过的无效 K 线数' WHEN 'batch_no' THEN '原子检查点和结果批次序号' WHEN 'config_checksum' THEN '配置快照 SHA256 校验和' WHEN 'state_json' THEN '引擎状态、指标缓存和输入游标' WHEN 'execution_epoch' THEN '提交结果的执行代次' WHEN 'created_at' THEN '提交时间' WHEN 'request_id' THEN '客户端幂等请求标识' WHEN 'source_run_id' THEN '重新回测来源任务' WHEN 'new_run_id' THEN '新建回测任务' END);
 END LOOP;
END $$;
