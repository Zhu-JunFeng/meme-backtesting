-- 选点版本保存于既有 JSON；不修改历史策略版本、任务快照或成交。
COMMENT ON COLUMN live_runs.execution_version IS '实时执行规则版本；closed-bar-v2 收盘决策；closed-bar-v3 保留收盘决策并切换 pullback-v2 Fib 候选生命周期';
COMMENT ON COLUMN live_runs.execution_switched_at IS '最近实时执行规则切换时间；仅切换后的完整K线可决策，原持仓锚点和成本保持不变';
UPDATE backtest_condition_definitions
SET implementation_version='2.0.0', description='已确认 Fractal Pivot；新版本按最近高点匹配最近合格低点，区间内不得有更高 High；候选锁定至收盘破高、破低或回看过期，买入后锁定原锚点。旧任务按原快照执行。', updated_at=now()
WHERE code='impulse_fractal_swing';
