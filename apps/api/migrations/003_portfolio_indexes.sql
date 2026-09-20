CREATE INDEX IF NOT EXISTS meme_kline_valid_dimension_ca_time ON public.meme_kline(interval,type,chain,ca,pair_id,open_time) WHERE valid IS DISTINCT FROM false;
COMMENT ON INDEX public.meme_kline_valid_dimension_ca_time IS '按周期和价值维度筛选有效 CA、交易池及回测时间范围';
CREATE INDEX IF NOT EXISTS meme_kline_ca_pairs ON public.meme_kline(chain,ca,pair_id);
COMMENT ON INDEX public.meme_kline_ca_pairs IS '按链和 CA 解析全部交易池（包括所选维度无数据的池）';
CREATE INDEX CONCURRENTLY IF NOT EXISTS backtest_signals_pool_time ON backtest_signals(run_id,chain,ca,pair_id,time,id);
COMMENT ON INDEX backtest_signals_pool_time IS '任务 CA 交易池事件时间线和图表分页索引';
CREATE INDEX CONCURRENTLY IF NOT EXISTS backtest_trades_pool_time ON backtest_trades(run_id,chain,ca,pair_id,entry_time,id);
COMMENT ON INDEX backtest_trades_pool_time IS '任务 CA 交易池成交详情分页索引';
