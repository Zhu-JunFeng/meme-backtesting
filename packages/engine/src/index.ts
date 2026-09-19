import type { BacktestConfig, BacktestReport, Candle, ConditionGroup, EquityPoint, Signal, SymbolRef, Trade } from "@meme/domain";

const finite = (n: number) => Number.isFinite(n);
const periodSeconds: Record<string, number> = { "30s": 30, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

export function normalizeCandles(input: Candle[], interval: keyof typeof periodSeconds): { candles: Candle[]; syntheticBars: number; invalidBars: number } {
  const step = periodSeconds[interval] * 1000;
  const sorted = [...input].sort((a, b) => a.time - b.time);
  const out: Candle[] = [];
  let syntheticBars = 0;
  let invalidBars = 0;
  for (const original of sorted) {
    const invalid = ![original.open, original.high, original.low, original.close, original.volume].every(finite) || original.high < Math.max(original.open, original.close) || original.low > Math.min(original.open, original.close) || original.high < original.low || original.volume < 0;
    if (invalid) { invalidBars++; continue; }
    if (out.length) {
      let next = out[out.length - 1].time + step;
      while (next < original.time) {
        const close = out[out.length - 1].close;
        out.push({ time: next, closeTime: next + step, open: close, high: close, low: close, close, volume: 0, synthetic: true, valid: true });
        syntheticBars++; next += step;
      }
    }
    out.push({ ...original, closeTime: original.closeTime || original.time + step, valid: true });
  }
  return { candles: out, syntheticBars, invalidBars };
}

function sma(values: number[], period: number): number | undefined { if (values.length < period) return undefined; return values.slice(-period).reduce((a, b) => a + b, 0) / period; }
function rsi(values: number[], period: number): number | undefined {
  if (values.length <= period) return undefined;
  const changes = values.slice(-period - 1).slice(1).map((v, i) => v - values.slice(-period - 1)[i]);
  const gain = changes.filter(v => v > 0).reduce((a, v) => a + v, 0) / period;
  const loss = Math.abs(changes.filter(v => v < 0).reduce((a, v) => a + v, 0)) / period;
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}
function compare(value: number | undefined, operator: string, target?: number, previous?: number, previousTarget?: number): boolean {
  if (value === undefined) return false;
  if (operator === "gt") return value > (target ?? 0); if (operator === "gte") return value >= (target ?? 0); if (operator === "lt") return value < (target ?? 0); if (operator === "lte") return value <= (target ?? 0);
  if (operator === "crossUp") return previous !== undefined && previousTarget !== undefined && previous <= previousTarget && value > (target ?? 0);
  if (operator === "crossDown") return previous !== undefined && previousTarget !== undefined && previous >= previousTarget && value < (target ?? 0);
  return false;
}

function pattern(candles: Candle[], name: string): boolean {
  const c = candles.at(-1); const p = candles.at(-2); if (!c) return false;
  const body = Math.abs(c.close - c.open); const lower = Math.min(c.open, c.close) - c.low; const upper = c.high - Math.max(c.open, c.close);
  if (name === "hammer") return lower >= body * 2 && upper <= body;
  if (name === "long_lower_wick") return lower >= Math.max(body * 2, (c.high - c.low) * 0.4);
  if (name === "bullish_engulfing") return !!p && p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open;
  if (name === "bullish_volume") return c.close > c.open && !!p && c.volume > p.volume * 1.5;
  return false;
}

function conditionMet(group: ConditionGroup, candles: Candle[]): boolean {
  const values = candles.map(c => c.close); const volumes = candles.map(c => c.volume); const current = candles.at(-1); const previous = candles.at(-2);
  const result = group.conditions.map(condition => "logic" in condition ? conditionMet(condition, candles) : (() => {
    if (condition.type === "rsi") return compare(rsi(values, condition.period), condition.operator, condition.value);
    if (condition.type === "sma" || condition.type === "ema") return compare(sma(values, condition.period), condition.operator, condition.value);
    if (condition.type === "volume_ratio") { const avg = sma(volumes.slice(0, -1), condition.period); return avg ? compare((current?.volume ?? 0) / avg, condition.operator, condition.value) : false; }
    if (condition.type === "candle_pattern") return pattern(candles, condition.pattern);
    if (condition.type === "fib_retracement") {
      if (candles.length < 3) return false;
      const lookback = candles.slice(-condition.maxBars); const low = Math.min(...lookback.map(c => c.low)); const high = Math.max(...lookback.map(c => c.high));
      if (high <= low || (high / low - 1) * 100 < condition.impulseMinPercent || !current) return false;
      const ratio = (high - current.close) / (high - low); const inZone = ratio >= condition.zoneLow && ratio <= condition.zoneHigh;
      const volumeOk = !condition.requireVolumeContraction || (sma(volumes.slice(0, -1), Math.min(10, volumes.length - 1)) ?? Infinity) * (condition.volumeRatioMax ?? 1) >= (current.volume ?? 0);
      const patternOk = !condition.confirmationPatterns?.length || condition.confirmationPatterns.some(p => pattern(candles, p));
      return inZone && volumeOk && patternOk;
    }
    return false;
  })());
  return group.logic === "AND" ? result.every(Boolean) : result.some(Boolean);
}

export interface SymbolInput { symbol: SymbolRef; candles: Candle[] }
export interface BacktestResult { report: BacktestReport; trades: Trade[]; signals: Array<Signal & { symbol: SymbolRef }>; equity: EquityPoint[] }

export function runBacktest(config: BacktestConfig, inputs: SymbolInput[], onProgress?: (value: number) => void): BacktestResult {
  let cash = config.initialCapital; let peak = cash; let maxDrawdown = 0; let maxDrawdownPercent = 0; let syntheticBars = 0; let invalidBars = 0; const riskEvents = 0;
  const trades: Trade[] = []; const signals: Array<Signal & { symbol: SymbolRef }> = []; const equity: EquityPoint[] = []; const active = new Map<string, Trade>(); let processed = 0;
  for (const input of inputs) {
    const normalized = normalizeCandles(input.candles, config.interval); syntheticBars += normalized.syntheticBars; invalidBars += normalized.invalidBars; const candles = normalized.candles; const key = `${input.symbol.chain}:${input.symbol.pairId}`;
    let previousClose: number | undefined;
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i]; const history = candles.slice(0, i + 1); const current = active.get(key);
      if (current) {
        const stop = config.exitConfig.stopLoss.type === "percent" ? current.entryPrice * (1 - config.exitConfig.stopLoss.value / 100) : current.entryPrice * 0.9;
        const target = config.exitConfig.takeProfit.type === "percent" ? current.entryPrice * (1 + config.exitConfig.takeProfit.value / 100) : current.entryPrice * 1.2;
        let exit: { price: number; type: "stop_loss" | "take_profit" | "timeout" } | undefined;
        if (candle.open <= stop || candle.low <= stop) exit = { price: candle.open <= stop ? candle.open : stop, type: "stop_loss" };
        else if (candle.open >= target || candle.high >= target) exit = { price: candle.open >= target ? candle.open : target, type: "take_profit" };
        else if (config.exitConfig.maxHoldingBars && i - (current.entryTime / 1000 / periodSeconds[config.interval]) >= config.exitConfig.maxHoldingBars) exit = { price: candle.close, type: "timeout" };
        if (exit) {
          const direction = exit.type === "stop_loss" ? -1 : 1; const gross = (exit.price - current.entryPrice) * current.quantity; const fees = (current.entryPrice * current.quantity + exit.price * current.quantity) * config.executionConfig.feePercent / 100; const slip = Math.abs(current.entryPrice * current.quantity + exit.price * current.quantity) * config.executionConfig.slippagePercent / 100; const tax = (current.entryPrice * current.quantity * config.executionConfig.buyTaxPercent + exit.price * current.quantity * config.executionConfig.sellTaxPercent) / 100; current.exitTime = candle.time; current.exitPrice = exit.price; current.grossPnl = gross; current.fees = fees; current.slippageCost = slip; current.taxCost = tax; current.netPnl = gross - fees - slip - tax; current.exitReason = exit.type; current.holdingBars = i; cash += current.quantity * exit.price + current.netPnl;
          const signal = { symbol: input.symbol, time: candle.time, price: exit.price, type: exit.type as Signal["type"], reason: { exit: exit.type }, quantity: current.quantity }; signals.push(signal); trades.push(current); active.delete(key);
        }
      }
      const entryNow = conditionMet(config.entryConditions, history);
      const entryBefore = i > 0 ? conditionMet(config.entryConditions, candles.slice(0, i)) : false;
      if (active.has(key) && config.positionConfig.mode === "pyramiding" && entryNow && !entryBefore) {
        const existing = active.get(key)!;
        if (existing.adds.length + 1 < config.positionConfig.maxEntries) {
          const amount = config.positionConfig.sizing.type === "fixed_amount" ? config.positionConfig.sizing.value : cash * config.positionConfig.sizing.value / 100;
          const price = candle.close; const quantity = amount / price; const previousValue = existing.entryPrice * existing.quantity;
          existing.entryPrice = (previousValue + amount) / (existing.quantity + quantity); existing.quantity += quantity; existing.fees += amount * config.executionConfig.feePercent / 100; existing.slippageCost += amount * config.executionConfig.slippagePercent / 100; existing.taxCost += amount * config.executionConfig.buyTaxPercent / 100; cash -= amount;
          const add = { time: candle.time, price, type: "add" as const, quantity, reason: { conditions: config.entryConditions } }; existing.adds.push(add); signals.push({ symbol: input.symbol, ...add });
        }
      }
      if (!active.has(key) && entryNow && (config.positionConfig.allowReentry || !trades.some(t => t.symbol.pairId === input.symbol.pairId))) {
        const amount = config.positionConfig.sizing.type === "fixed_amount" ? config.positionConfig.sizing.value : cash * config.positionConfig.sizing.value / 100; const price = candle.close; const quantity = amount / price; cash -= amount; const trade: Trade = { symbol: input.symbol, entryTime: candle.time, entryPrice: price, quantity, fees: amount * config.executionConfig.feePercent / 100, slippageCost: amount * config.executionConfig.slippagePercent / 100, taxCost: amount * config.executionConfig.buyTaxPercent / 100, adds: [] }; active.set(key, trade); signals.push({ symbol: input.symbol, time: candle.time, price, type: "entry", quantity, reason: { conditions: config.entryConditions } });
      }
      const unrealized = [...active.values()].reduce((sum, t) => sum + (candle.close - t.entryPrice) * t.quantity, 0); const total = cash + unrealized + [...active.values()].reduce((sum, t) => sum + t.entryPrice * t.quantity, 0); peak = Math.max(peak, total); const dd = peak - total; maxDrawdown = Math.max(maxDrawdown, dd); maxDrawdownPercent = Math.max(maxDrawdownPercent, peak ? dd / peak * 100 : 0); equity.push({ time: candle.time, equity: total, cash, unrealized }); previousClose = candle.close; processed++; onProgress?.(Math.min(1, processed / Math.max(1, inputs.reduce((n, x) => n + x.candles.length, 0))));
    }
    const open = active.get(key); if (open && config.exitConfig.closeAtEnd) { const last = candles.at(-1)!; const net = (last.close - open.entryPrice) * open.quantity - open.fees - open.slippageCost - open.taxCost; open.exitTime = last.time; open.exitPrice = last.close; open.grossPnl = (last.close - open.entryPrice) * open.quantity; open.netPnl = net; open.exitReason = "end_of_backtest"; trades.push(open); active.delete(key); }
  }
  const wins = trades.filter(t => (t.netPnl ?? 0) > 0); const losses = trades.filter(t => (t.netPnl ?? 0) <= 0); const netPnl = trades.reduce((n, t) => n + (t.netPnl ?? 0), 0); const grossProfit = wins.reduce((n, t) => n + (t.netPnl ?? 0), 0); const grossLoss = Math.abs(losses.reduce((n, t) => n + (t.netPnl ?? 0), 0));
  const bySymbol = [...new Set(trades.map(t => `${t.symbol.chain}:${t.symbol.ca}:${t.symbol.pairId}`))].map(id => { const ts = trades.filter(t => `${t.symbol.chain}:${t.symbol.ca}:${t.symbol.pairId}` === id); return { symbol: ts[0].symbol, trades: ts.length, netPnl: ts.reduce((n, t) => n + (t.netPnl ?? 0), 0), winRate: ts.length ? ts.filter(t => (t.netPnl ?? 0) > 0).length / ts.length : 0 }; });
  return { trades, signals, equity, report: { totalTrades: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? wins.length / trades.length : 0, grossPnl: trades.reduce((n, t) => n + (t.grossPnl ?? 0), 0), netPnl, returnPercent: config.initialCapital ? netPnl / config.initialCapital * 100 : 0, profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0, maxDrawdown, maxDrawdownPercent, maxConsecutiveLosses: 0, averageHoldingBars: trades.length ? trades.reduce((n, t) => n + (t.holdingBars ?? 0), 0) / trades.length : 0, dataQuality: { syntheticBars, invalidBars, riskEvents }, bySymbol } };
}
