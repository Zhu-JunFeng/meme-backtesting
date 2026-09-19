CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER TABLE IF EXISTS public.meme_kline ADD COLUMN IF NOT EXISTS valid boolean NOT NULL DEFAULT true;
ALTER TABLE IF EXISTS public.meme_kline ADD COLUMN IF NOT EXISTS invalid_reason text;
UPDATE public.meme_kline SET valid = false, invalid_reason = COALESCE(invalid_reason, 'invalid_ohlc')
WHERE high < GREATEST(open, close) OR low > LEAST(open, close) OR high < low OR open < 0 OR high < 0 OR low < 0 OR close < 0 OR volume < 0;
CREATE TABLE IF NOT EXISTS backtest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, status text NOT NULL, config_json jsonb NOT NULL,
  progress numeric NOT NULL DEFAULT 0, error_message text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS backtest_signals (id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE, chain text NOT NULL, ca text NOT NULL, pair_id text NOT NULL, time bigint NOT NULL, price numeric NOT NULL, signal_type text NOT NULL, reason_json jsonb NOT NULL, quantity numeric);
CREATE TABLE IF NOT EXISTS backtest_trades (id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE, chain text NOT NULL, ca text NOT NULL, pair_id text NOT NULL, entry_time bigint NOT NULL, entry_price numeric NOT NULL, quantity numeric NOT NULL, exit_time bigint, exit_price numeric, gross_pnl numeric, fees numeric NOT NULL, slippage_cost numeric NOT NULL, tax_cost numeric NOT NULL, net_pnl numeric, exit_reason text, holding_bars integer, adds_json jsonb NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS backtest_equity_curve (run_id uuid NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE, time bigint NOT NULL, equity numeric NOT NULL, cash numeric NOT NULL, unrealized numeric NOT NULL, PRIMARY KEY(run_id,time));
CREATE TABLE IF NOT EXISTS backtest_reports (run_id uuid PRIMARY KEY REFERENCES backtest_runs(id) ON DELETE CASCADE, report_json jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_backtest_signals_run_time ON backtest_signals(run_id,time);

COMMENT ON TABLE public.meme_kline IS 'Meme 币原始及清洗后的 K 线行情表，按链、CA、交易池、周期和 K 线类型保存 OHLCV 数据。';
COMMENT ON COLUMN public.meme_kline.chain IS '区块链名称，例如 robin、sol、eth、bsc。';
COMMENT ON COLUMN public.meme_kline.ca IS 'Meme 币代币合约地址（Contract Address）。';
COMMENT ON COLUMN public.meme_kline.pair_id IS '交易池或交易对合约地址。';
COMMENT ON COLUMN public.meme_kline.interval IS 'K 线周期，例如 30s、1m、5m、1h。';
COMMENT ON COLUMN public.meme_kline.open_time IS 'K 线开始时间，Unix 毫秒时间戳。';
COMMENT ON COLUMN public.meme_kline.close_time IS 'K 线结束时间，Unix 毫秒时间戳。';
COMMENT ON COLUMN public.meme_kline.open IS '开盘值，含义由 type 决定，可能是价格或市值。';
COMMENT ON COLUMN public.meme_kline.high IS '最高值，含义由 type 决定。';
COMMENT ON COLUMN public.meme_kline.low IS '最低值，含义由 type 决定。';
COMMENT ON COLUMN public.meme_kline.close IS '收盘值，含义由 type 决定。';
COMMENT ON COLUMN public.meme_kline.volume IS '成交量或成交额，具体含义由数据源定义。';
COMMENT ON COLUMN public.meme_kline.trade_count IS '该 K 线内的成交笔数。';
COMMENT ON COLUMN public.meme_kline.type IS 'K 线数值类型：price 表示价格，mcap 表示市值。';
COMMENT ON COLUMN public.meme_kline.source IS '行情数据来源，例如 xxyy、birdeye 或其他供应商。';
COMMENT ON COLUMN public.meme_kline.raw_data IS '数据源返回的原始 JSON 数据。';
COMMENT ON COLUMN public.meme_kline.created_at IS '记录写入数据库的时间。';
COMMENT ON COLUMN public.meme_kline.valid IS '数据质量标记：true 表示可用于回测，false 表示异常数据。';
COMMENT ON COLUMN public.meme_kline.invalid_reason IS '数据无效原因，例如 invalid_ohlc、negative_volume。';

COMMENT ON TABLE backtest_runs IS '回测任务主表，保存回测配置快照、运行状态和进度。';
COMMENT ON COLUMN backtest_runs.id IS '回测任务唯一标识。';
COMMENT ON COLUMN backtest_runs.name IS '回测任务名称。';
COMMENT ON COLUMN backtest_runs.status IS '任务状态：pending、running、completed、failed、cancelled。';
COMMENT ON COLUMN backtest_runs.config_json IS '不可变的回测配置快照，保证结果可复现。';
COMMENT ON COLUMN backtest_runs.progress IS '任务进度，范围为 0 到 1。';
COMMENT ON COLUMN backtest_runs.error_message IS '任务失败或取消时的错误及诊断信息。';
COMMENT ON COLUMN backtest_runs.created_at IS '任务创建时间。';
COMMENT ON COLUMN backtest_runs.finished_at IS '任务完成、失败或取消时间。';

COMMENT ON TABLE backtest_signals IS '回测策略信号表，保存每个项目触发的入场、加仓和出场信号。';
COMMENT ON COLUMN backtest_signals.id IS '信号记录唯一标识。';
COMMENT ON COLUMN backtest_signals.run_id IS '所属回测任务。';
COMMENT ON COLUMN backtest_signals.chain IS '项目所属区块链。';
COMMENT ON COLUMN backtest_signals.ca IS '项目代币合约地址。';
COMMENT ON COLUMN backtest_signals.pair_id IS '项目交易池地址。';
COMMENT ON COLUMN backtest_signals.time IS '信号触发时间，Unix 毫秒时间戳。';
COMMENT ON COLUMN backtest_signals.price IS '信号触发价格或市值。';
COMMENT ON COLUMN backtest_signals.signal_type IS '信号类型：entry、add、take_profit、stop_loss、timeout、risk_event。';
COMMENT ON COLUMN backtest_signals.reason_json IS '触发信号的指标、阈值和策略上下文。';
COMMENT ON COLUMN backtest_signals.quantity IS '本次信号对应的数量。';

COMMENT ON TABLE backtest_trades IS '回测完整交易表，一条记录代表从入场到出场的一笔合并交易。';
COMMENT ON COLUMN backtest_trades.id IS '交易记录唯一标识。';
COMMENT ON COLUMN backtest_trades.run_id IS '所属回测任务。';
COMMENT ON COLUMN backtest_trades.chain IS '项目所属区块链。';
COMMENT ON COLUMN backtest_trades.ca IS '项目代币合约地址。';
COMMENT ON COLUMN backtest_trades.pair_id IS '项目交易池地址。';
COMMENT ON COLUMN backtest_trades.entry_time IS '首次入场时间，Unix 毫秒时间戳。';
COMMENT ON COLUMN backtest_trades.entry_price IS '合并加仓后的加权平均入场价格。';
COMMENT ON COLUMN backtest_trades.quantity IS '合并后的总持仓数量。';
COMMENT ON COLUMN backtest_trades.exit_time IS '出场时间，Unix 毫秒时间戳。';
COMMENT ON COLUMN backtest_trades.exit_price IS '最终出场价格。';
COMMENT ON COLUMN backtest_trades.gross_pnl IS '扣除交易成本前的毛盈亏。';
COMMENT ON COLUMN backtest_trades.fees IS '交易手续费总额。';
COMMENT ON COLUMN backtest_trades.slippage_cost IS '滑点造成的成本。';
COMMENT ON COLUMN backtest_trades.tax_cost IS '买入税和卖出税总额。';
COMMENT ON COLUMN backtest_trades.net_pnl IS '扣除手续费、滑点和税后的净盈亏。';
COMMENT ON COLUMN backtest_trades.exit_reason IS '出场原因，例如 take_profit、stop_loss、timeout、end_of_backtest。';
COMMENT ON COLUMN backtest_trades.holding_bars IS '持仓持续的 K 线数量。';
COMMENT ON COLUMN backtest_trades.adds_json IS '该交易的加仓记录数组。';

COMMENT ON TABLE backtest_equity_curve IS '回测权益曲线表，保存每个时间点的现金、浮动盈亏和账户权益。';
COMMENT ON COLUMN backtest_equity_curve.run_id IS '所属回测任务。';
COMMENT ON COLUMN backtest_equity_curve.time IS '权益快照时间，Unix 毫秒时间戳。';
COMMENT ON COLUMN backtest_equity_curve.equity IS '该时间点的账户总权益。';
COMMENT ON COLUMN backtest_equity_curve.cash IS '该时间点的可用现金。';
COMMENT ON COLUMN backtest_equity_curve.unrealized IS '该时间点的持仓浮动盈亏。';

COMMENT ON TABLE backtest_reports IS '回测汇总报告表，保存组合绩效和数据质量指标。';
COMMENT ON COLUMN backtest_reports.run_id IS '所属回测任务，同时作为报告唯一标识。';
COMMENT ON COLUMN backtest_reports.report_json IS '汇总报告 JSON，包括收益、胜率、最大回撤和按项目统计。';
COMMENT ON COLUMN backtest_reports.created_at IS '报告生成时间。';
