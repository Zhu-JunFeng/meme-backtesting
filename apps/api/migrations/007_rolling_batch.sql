CREATE TABLE IF NOT EXISTS backtest_batch_control (
 batch_id text PRIMARY KEY,
 manifest_checksum text NOT NULL,
 status text NOT NULL CHECK(status IN ('active','paused','completed')),
 wave integer NOT NULL DEFAULT 0,
 total integer NOT NULL,
 batch_size integer NOT NULL DEFAULT 50 CHECK(batch_size BETWEEN 1 AND 50),
 keep_per_chain integer NOT NULL DEFAULT 10 CHECK(keep_per_chain=10),
 pilot_evidence jsonb NOT NULL,
 last_error text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS backtest_batch_items (
 batch_id text NOT NULL REFERENCES backtest_batch_control(batch_id) ON DELETE RESTRICT,
 run_id uuid NOT NULL,
 ordinal integer NOT NULL,
 chain text NOT NULL,
 combination text NOT NULL,
 strategy_checksum text NOT NULL,
 state text NOT NULL DEFAULT 'planned' CHECK(state IN ('planned','submitted','retained','pruned')),
 wave integer,
 return_percent double precision,
 max_drawdown_percent double precision,
 summary_json jsonb,
 result_bytes bigint,
 finished_at timestamptz,
 pruned_at timestamptz,
 PRIMARY KEY(batch_id,run_id), UNIQUE(batch_id,ordinal)
);
CREATE INDEX IF NOT EXISTS backtest_batch_items_state ON backtest_batch_items(batch_id,state,ordinal);
CREATE INDEX IF NOT EXISTS backtest_batch_items_rank ON backtest_batch_items(batch_id,chain,return_percent DESC,max_drawdown_percent,ordinal);
COMMENT ON TABLE backtest_batch_control IS '用户授权的滚动回测批次；每轮最多50个、每链累计保留前十';
COMMENT ON TABLE backtest_batch_items IS '轻量执行清单和淘汰墓碑；run_id不设外键，删除任务后仍防止重复执行';
DO $$ DECLARE col record; BEGIN
 FOR col IN SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('backtest_batch_control','backtest_batch_items') LOOP
 EXECUTE format('COMMENT ON COLUMN public.%I.%I IS %L',col.table_name,col.column_name,
 CASE col.column_name WHEN 'batch_id' THEN '固定实验批次标识' WHEN 'manifest_checksum' THEN '批准参数与来源清单校验和，禁止中途换配置' WHEN 'status' THEN '调度状态：active自动推进、paused暂停、completed全部完成'
 WHEN 'wave' THEN '批次轮次；0为已完成先导任务' WHEN 'total' THEN '清单任务总数' WHEN 'batch_size' THEN '每轮最多提交任务数' WHEN 'keep_per_chain' THEN '每条链独立累计保留数量'
 WHEN 'pilot_evidence' THEN '原始先导对照验证及来源证据快照' WHEN 'last_error' THEN '最近暂停或执行错误原因' WHEN 'updated_at' THEN '最近协调时间'
 WHEN 'run_id' THEN '确定性任务ID；任务删除后仍保留墓碑' WHEN 'ordinal' THEN '确定性提交与同分排序序号' WHEN 'chain' THEN '排名所属链' WHEN 'combination' THEN '参数组合代码'
 WHEN 'strategy_checksum' THEN '不可变策略校验和' WHEN 'state' THEN 'planned未提交、submitted本轮、retained前十、pruned已淘汰'
 WHEN 'return_percent' THEN '完整报告税费后收益率，包含结束平仓；不舍入排名' WHEN 'max_drawdown_percent' THEN '同收益率时优先较小最大回撤百分比'
 WHEN 'summary_json' THEN '轻量成绩与错误信息，不保存逐笔交易、逐池明细及曲线' WHEN 'result_bytes' THEN '测量的结果行体积，用于下一轮空间预算'
 WHEN 'finished_at' THEN '任务完成时间' WHEN 'pruned_at' THEN '删除任务及级联结果时间' END);
 END LOOP;
END $$;
