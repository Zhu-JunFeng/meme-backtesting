ALTER TABLE public.live_orders ADD COLUMN IF NOT EXISTS position_id uuid;
COMMENT ON COLUMN public.live_orders.position_id IS '本次完整持仓周期标识，首次买入订单 ID；加仓和卖出沿用该 ID';
CREATE INDEX IF NOT EXISTS live_orders_position_id ON public.live_orders(run_id,position_id) WHERE position_id IS NOT NULL;

ALTER TABLE public.live_fills ADD COLUMN IF NOT EXISTS market_cap numeric;
COMMENT ON COLUMN public.live_fills.market_cap IS '实际成交时可信的代币市值，缺失时不得由价格估算';
