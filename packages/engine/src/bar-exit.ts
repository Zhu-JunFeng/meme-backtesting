import type { Candle } from '@meme/domain';

/** The completed-bar matching rule shared by historical and live evaluators. */
export function matchBarExit(c: Candle, p: {
  entry: number; baseStop: number; lockPrice?: number; target: number;
  invalid: () => boolean; timedOut: boolean; end?: boolean;
}) {
  const stop = Math.max(p.baseStop, p.lockPrice ?? -Infinity);
  if (c.open <= stop || c.low <= stop)
    return {price: c.open <= stop ? c.open : stop, type: (p.lockPrice ?? -Infinity) > p.baseStop ? 'profit_lock' as const : 'stop_loss' as const};
  if (p.invalid()) return {price: c.close, type: 'invalidation' as const};
  if (p.target > p.entry && (c.open >= p.target || c.high >= p.target))
    return {price: c.open >= p.target ? c.open : p.target, type: 'take_profit' as const};
  if (p.timedOut) return {price: c.close, type: 'timeout' as const};
  if (p.end) return {price: c.close, type: 'end_of_backtest' as const};
}
