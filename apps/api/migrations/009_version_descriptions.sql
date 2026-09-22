-- Descriptive metadata is deliberately outside engine configuration/checksums.
ALTER TABLE backtest_strategy_versions ADD COLUMN IF NOT EXISTS description_json jsonb;
COMMENT ON COLUMN backtest_strategy_versions.description_json IS '不可变版本说明：自动生成流程、人工补充备注及生成器版本；旧版本为空，不回填';
ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS strategy_description_json jsonb;
COMMENT ON COLUMN backtest_runs.strategy_description_json IS '任务创建时冻结的策略版本说明及执行覆盖项；与撮合配置分离，重试和重新回测沿用原值；旧任务为空';
