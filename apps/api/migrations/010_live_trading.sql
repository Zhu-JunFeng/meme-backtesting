BEGIN;
CREATE TABLE IF NOT EXISTS public.live_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL,
 mode text NOT NULL CHECK (mode IN ('paper','live')),
 chain text NOT NULL CHECK (chain IN ('sol','bsc','robin')),
 interval text NOT NULL CHECK (interval IN ('30s','1m')),
 value_type text NOT NULL CHECK (value_type IN ('price','mcap')),
 strategy_version_id uuid NOT NULL REFERENCES public.backtest_strategy_versions(id) ON DELETE RESTRICT,
 strategy_json jsonb NOT NULL, initial_capital numeric NOT NULL CHECK(initial_capital>0),
 wallet_address text, risk_json jsonb, status text NOT NULL DEFAULT 'paused'
   CHECK(status IN ('paused','running','stopped','attention')),
 cash numeric NOT NULL, realized_pnl numeric NOT NULL DEFAULT 0,
 started_at timestamptz, heartbeat_at timestamptz, error_message text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(mode='paper' OR (wallet_address IS NOT NULL AND risk_json IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS live_runs_dedicated_wallet ON public.live_runs(chain,lower(wallet_address))
 WHERE mode='live';
CREATE INDEX IF NOT EXISTS live_runs_status ON public.live_runs(status,mode);
COMMENT ON TABLE public.live_runs IS '实时模拟盘与实盘任务，保存不可变策略快照和独立资金状态';
COMMENT ON COLUMN public.live_runs.id IS '实时任务主键';
COMMENT ON COLUMN public.live_runs.name IS '任务名称';
COMMENT ON COLUMN public.live_runs.mode IS '运行模式：paper 模拟盘，live 实盘';
COMMENT ON COLUMN public.live_runs.chain IS '监控链';
COMMENT ON COLUMN public.live_runs.interval IS '策略判断 K 线周期';
COMMENT ON COLUMN public.live_runs.value_type IS '策略判断维度：价格或市值';
COMMENT ON COLUMN public.live_runs.strategy_version_id IS '引用的不可变策略版本';
COMMENT ON COLUMN public.live_runs.strategy_json IS '任务创建时冻结的策略完整快照';
COMMENT ON COLUMN public.live_runs.initial_capital IS '初始资金，模拟盘为记账金额，实盘为额度基准';
COMMENT ON COLUMN public.live_runs.wallet_address IS '实盘专用 XXYY 钱包公开地址，不保存私钥';
COMMENT ON COLUMN public.live_runs.risk_json IS '单笔、总敞口、日亏损及交易参数硬性上限';
COMMENT ON COLUMN public.live_runs.status IS '运行状态：暂停、运行、停止、待人工处理';
COMMENT ON COLUMN public.live_runs.cash IS '模拟现金或最近核对后的实盘可用额';
COMMENT ON COLUMN public.live_runs.realized_pnl IS '已实现净盈亏';
COMMENT ON COLUMN public.live_runs.started_at IS '首次启动时间；只纳入此后到达的新信号';
COMMENT ON COLUMN public.live_runs.heartbeat_at IS '实时服务最近心跳';
COMMENT ON COLUMN public.live_runs.error_message IS '需要处理的故障说明，不含密钥';
COMMENT ON COLUMN public.live_runs.created_at IS '任务创建时间';
COMMENT ON COLUMN public.live_runs.updated_at IS '任务更新时间';

CREATE TABLE IF NOT EXISTS public.live_watches (
 run_id uuid NOT NULL REFERENCES public.live_runs(id) ON DELETE CASCADE,
 chain text NOT NULL, ca text NOT NULL, pair_id text NOT NULL,
 signal_source text NOT NULL, signal_key text NOT NULL, signal_time bigint NOT NULL,
 state_json jsonb NOT NULL DEFAULT '{}', last_candle_time bigint,
 status text NOT NULL DEFAULT 'monitoring', created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,chain,ca)
);
CREATE INDEX IF NOT EXISTS live_watches_pair ON public.live_watches(chain,pair_id,status);
COMMENT ON TABLE public.live_watches IS '实时任务监控的信号项目，每任务每链合约只纳入一次';
COMMENT ON COLUMN public.live_watches.run_id IS '所属实时任务';
COMMENT ON COLUMN public.live_watches.chain IS '所属链';
COMMENT ON COLUMN public.live_watches.ca IS '合约地址';
COMMENT ON COLUMN public.live_watches.pair_id IS 'MemeInfo 主交易池';
COMMENT ON COLUMN public.live_watches.signal_source IS '首次纳入该任务的外部信号来源';
COMMENT ON COLUMN public.live_watches.signal_key IS '外部信号去重键';
COMMENT ON COLUMN public.live_watches.signal_time IS '外部信号原始触发时间，Unix 毫秒';
COMMENT ON COLUMN public.live_watches.state_json IS '有限历史、指标边沿、持仓和锁盈状态';
COMMENT ON COLUMN public.live_watches.last_candle_time IS '最后处理的收盘 K 线开盘时间';
COMMENT ON COLUMN public.live_watches.status IS '监控状态或待处理原因';
COMMENT ON COLUMN public.live_watches.created_at IS '项目纳入监控时间';

CREATE TABLE IF NOT EXISTS public.live_orders (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES public.live_runs(id) ON DELETE CASCADE,
 chain text NOT NULL, ca text NOT NULL, pair_id text NOT NULL,
 intent_key text NOT NULL UNIQUE, side text NOT NULL CHECK(side IN ('buy','sell')),
 reason text NOT NULL, status text NOT NULL CHECK(status IN ('pending','submitted','filled','failed','unknown')),
 decision_time bigint NOT NULL, decision_value numeric NOT NULL,
 requested_amount numeric NOT NULL, tx_id text, raw_result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_orders_run_time ON public.live_orders(run_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS live_orders_tx_id ON public.live_orders(tx_id) WHERE tx_id IS NOT NULL;
COMMENT ON TABLE public.live_orders IS '模拟或实盘订单意图及 XXYY 提交状态；未知状态禁止盲重试';
COMMENT ON COLUMN public.live_orders.id IS '订单主键';
COMMENT ON COLUMN public.live_orders.run_id IS '所属实时任务';
COMMENT ON COLUMN public.live_orders.chain IS '所属链';
COMMENT ON COLUMN public.live_orders.ca IS '合约地址';
COMMENT ON COLUMN public.live_orders.pair_id IS '信号使用的交易池';
COMMENT ON COLUMN public.live_orders.intent_key IS '订单意图幂等键';
COMMENT ON COLUMN public.live_orders.side IS '买入或卖出';
COMMENT ON COLUMN public.live_orders.reason IS '策略触发原因';
COMMENT ON COLUMN public.live_orders.status IS '待提交、已提交、已成交、失败或结果未知';
COMMENT ON COLUMN public.live_orders.decision_time IS '产生决策的 Unix 毫秒时间';
COMMENT ON COLUMN public.live_orders.decision_value IS '产生决策时的价格或市值';
COMMENT ON COLUMN public.live_orders.requested_amount IS '模拟盘为计价金额；实盘买入为原生币数量、卖出为钱包持仓百分比';
COMMENT ON COLUMN public.live_orders.tx_id IS 'XXYY 返回的交易标识';
COMMENT ON COLUMN public.live_orders.raw_result IS '脱敏后的接口结果';
COMMENT ON COLUMN public.live_orders.created_at IS '订单创建时间';
COMMENT ON COLUMN public.live_orders.updated_at IS '订单更新时间';

CREATE TABLE IF NOT EXISTS public.live_fills (
 order_id uuid PRIMARY KEY REFERENCES public.live_orders(id) ON DELETE CASCADE,
 fill_time bigint NOT NULL, fill_price numeric NOT NULL CHECK(fill_price>0), fill_value numeric NOT NULL CHECK(fill_value>0),
 quantity numeric NOT NULL CHECK(quantity>0), gross_amount numeric NOT NULL CHECK(gross_amount>=0),
 fee numeric NOT NULL DEFAULT 0, slippage_cost numeric NOT NULL DEFAULT 0,
 tax_cost numeric NOT NULL DEFAULT 0, raw_result jsonb
);
COMMENT ON TABLE public.live_fills IS '模拟或真实成交结果；真实金额只使用可核对的交易回报';
COMMENT ON COLUMN public.live_fills.order_id IS '所属订单，一笔订单一条最终成交';
COMMENT ON COLUMN public.live_fills.fill_time IS '实际成交时间，Unix 毫秒';
COMMENT ON COLUMN public.live_fills.fill_price IS '实际成交代币价格';
COMMENT ON COLUMN public.live_fills.fill_value IS '成交时对应策略价格或市值维度的原始值';
COMMENT ON COLUMN public.live_fills.quantity IS '成交代币数量';
COMMENT ON COLUMN public.live_fills.gross_amount IS '未扣成本的成交计价金额';
COMMENT ON COLUMN public.live_fills.fee IS '成交手续费';
COMMENT ON COLUMN public.live_fills.slippage_cost IS '模拟或实际滑点成本';
COMMENT ON COLUMN public.live_fills.tax_cost IS '买卖税成本';
COMMENT ON COLUMN public.live_fills.raw_result IS '脱敏后的成交回报';

CREATE TABLE IF NOT EXISTS public.live_equity_curve (
 run_id uuid NOT NULL REFERENCES public.live_runs(id) ON DELETE CASCADE,
 time bigint NOT NULL, equity numeric NOT NULL, cash numeric NOT NULL,
 unrealized numeric NOT NULL, PRIMARY KEY(run_id,time)
);
COMMENT ON TABLE public.live_equity_curve IS '模拟盘按已收盘行情估算的实时权益；实盘需等待准确钱包对账';
COMMENT ON COLUMN public.live_equity_curve.run_id IS '所属实时任务';
COMMENT ON COLUMN public.live_equity_curve.time IS '权益计算所用的 K 线收盘时间，Unix 毫秒';
COMMENT ON COLUMN public.live_equity_curve.equity IS '现金加最近已知价格计算的持仓市值';
COMMENT ON COLUMN public.live_equity_curve.cash IS '模拟可用资金';
COMMENT ON COLUMN public.live_equity_curve.unrealized IS '按最近已知价格估算的未实现盈亏';

CREATE TABLE IF NOT EXISTS public.live_events (
 id bigserial PRIMARY KEY, run_id uuid REFERENCES public.live_runs(id) ON DELETE CASCADE,
 chain text, ca text, pair_id text, kind text NOT NULL, event_key text UNIQUE,
 event_time bigint NOT NULL, payload jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_events_run_time ON public.live_events(run_id,event_time DESC);
COMMENT ON TABLE public.live_events IS '实时外部信号、策略决策、断线、对账及风险事件流水';
COMMENT ON COLUMN public.live_events.id IS '流水主键';
COMMENT ON COLUMN public.live_events.run_id IS '可空任务标识；空表示全局行情或接入事件';
COMMENT ON COLUMN public.live_events.chain IS '所属链';
COMMENT ON COLUMN public.live_events.ca IS '合约地址';
COMMENT ON COLUMN public.live_events.pair_id IS '交易池';
COMMENT ON COLUMN public.live_events.kind IS '事件种类';
COMMENT ON COLUMN public.live_events.event_key IS '可选去重键';
COMMENT ON COLUMN public.live_events.event_time IS '事件原始 Unix 毫秒时间';
COMMENT ON COLUMN public.live_events.payload IS '脱敏的事件证据';
COMMENT ON COLUMN public.live_events.created_at IS '接收时间';
COMMIT;
