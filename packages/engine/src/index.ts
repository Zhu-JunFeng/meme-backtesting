import type { BacktestConfig, BacktestReport, Candle, Condition, ConditionGroup, EquityPoint, ImpulseConfig, Signal, SymbolRef, Trade } from "@meme/domain";

const finite = (n: number) => Number.isFinite(n);
const periodSeconds: Record<string, number> = { "30s": 30, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

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
        syntheticBars++;
        next += step;
      }
    }
    out.push({ ...original, closeTime: original.closeTime || original.time + step, valid: true });
  }
  return { candles: out, syntheticBars, invalidBars };
}

export interface Impulse { low: number; high: number; lowIndex: number; highIndex: number; confirmedAtIndex: number; gainPercent: number; averageVolume: number }

function isPivot(candles: Candle[], index: number, left: number, right: number, side: "low" | "high") {
  if (index < left || index + right >= candles.length) return false;
  const value = candles[index][side];
  const window = candles.slice(index - left, index + right + 1);
  return side === "low" ? window.every(c => value <= c.low) : window.every(c => value >= c.high);
}

export function detectImpulse(candles: Candle[], config: ImpulseConfig): Impulse | undefined {
  if (config.enabled === false || candles.length < config.leftBars + config.rightBars + 2) return undefined;
  const first = Math.max(config.leftBars, candles.length - config.lookbackBars);
  const lastConfirmed = candles.length - 1 - config.rightBars;
  const highs: number[] = [];
  const lows: number[] = [];
  for (let index = first; index <= lastConfirmed; index++) {
    if (isPivot(candles, index, config.leftBars, config.rightBars, "low")) lows.push(index);
    if (isPivot(candles, index, config.leftBars, config.rightBars, "high")) highs.push(index);
  }
  for (const highIndex of highs.reverse()) {
    for (const lowIndex of [...lows].reverse()) {
      if (lowIndex >= highIndex || highIndex - lowIndex > config.maxDurationBars) continue;
      const low = candles[lowIndex].low;
      const high = candles[highIndex].high;
      if (low <= 0) continue;
      const gainPercent = (high / low - 1) * 100;
      if (gainPercent < config.minGainPercent) continue;
      const impulseVolumes = candles.slice(lowIndex, highIndex + 1).map(c => c.volume);
      const impulseVolume = average(impulseVolumes) ?? 0;
      if (config.requireVolumeExpansion) {
        const baseline = average(candles.slice(Math.max(0, lowIndex - Math.max(5, config.leftBars * 2)), lowIndex).map(c => c.volume));
        if (baseline === undefined || impulseVolume < baseline * (config.volumeExpansionRatio ?? 1.5)) continue;
      }
      return { low, high, lowIndex, highIndex, confirmedAtIndex: highIndex + config.rightBars, gainPercent, averageVolume: impulseVolume };
    }
  }
  return undefined;
}

function emaSeries(values: number[], period: number): number[] {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) result.push(values[i] * multiplier + result[i - 1] * (1 - multiplier));
  return result;
}

function rsiAt(values: number[], period: number, end = values.length): number | undefined {
  if (end <= period) return undefined;
  const part = values.slice(0, end);
  const changes = part.slice(-period - 1).slice(1).map((value, index) => value - part.slice(-period - 1)[index]);
  const gain = changes.reduce((sum, value) => sum + Math.max(0, value), 0) / period;
  const loss = changes.reduce((sum, value) => sum + Math.max(0, -value), 0) / period;
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

function candlePattern(candles: Candle[], name: string): boolean {
  const current = candles.at(-1);
  const previous = candles.at(-2);
  if (!current) return false;
  const range = Math.max(Number.EPSILON, current.high - current.low);
  const body = Math.abs(current.close - current.open);
  const lower = Math.min(current.open, current.close) - current.low;
  const upper = current.high - Math.max(current.open, current.close);
  if (name === "hammer") return current.close >= current.open && lower >= Math.max(body * 2, range * .4) && upper <= range * .2;
  if (name === "pin_bar") return lower >= range * .55 && body <= range * .3;
  if (name === "long_lower_wick") return lower >= Math.max(body * 2, range * .4);
  if (name === "bullish_engulfing") return !!previous && previous.close < previous.open && current.close > current.open && current.open <= previous.close && current.close >= previous.open;
  return false;
}

function obv(candles: Candle[]): number[] {
  const values = [0];
  for (let i = 1; i < candles.length; i++) values.push(values[i - 1] + (candles[i].close > candles[i - 1].close ? candles[i].volume : candles[i].close < candles[i - 1].close ? -candles[i].volume : 0));
  return values;
}

export function evaluateCondition(condition: Condition, candles: Candle[], impulse: Impulse | undefined): boolean {
  if (condition.enabled === false) return false;
  const current = candles.at(-1);
  if (!current) return false;
  if (condition.type === "fib_retracement") {
    if (!impulse || current.time < candles[impulse.confirmedAtIndex]?.time) return false;
    const ratio = (impulse.high - current.close) / (impulse.high - impulse.low);
    return ratio >= condition.zoneLow && ratio <= condition.zoneHigh;
  }
  if (condition.type === "percent_retracement") {
    if (!impulse) return false;
    const percent = (impulse.high - current.close) / impulse.high * 100;
    return percent >= condition.minPercent && percent <= condition.maxPercent;
  }
  if (condition.type === "volume_contraction") {
    if (!impulse) return false;
    const pullback = candles.slice(Math.max(impulse.highIndex + 1, candles.length - condition.period));
    const pullbackAverage = average(pullback.map(c => c.volume));
    return pullbackAverage !== undefined && impulse.averageVolume > 0 && pullbackAverage / impulse.averageVolume <= condition.maxRatio;
  }
  if (condition.type === "bullish_volume_confirmation") {
    const baseline = average(candles.slice(Math.max(0, candles.length - 1 - condition.period), -1).map(c => c.volume));
    return current.close > current.open && baseline !== undefined && current.volume >= baseline * condition.minRatio;
  }
  if (condition.type === "candle_pattern") return condition.patterns.some(name => candlePattern(candles, name));
  if (condition.type === "rsi_recovery") {
    const closes = candles.map(c => c.close);
    const previous = rsiAt(closes, condition.period, closes.length - 1);
    const now = rsiAt(closes, condition.period);
    return previous !== undefined && now !== undefined && previous <= condition.oversold && now >= condition.recovery;
  }
  if (condition.type === "ema_reclaim") {
    if (candles.length < 2) return false;
    const values = candles.map(c => c.close);
    const moving = emaSeries(values, condition.period);
    return values.at(-2)! <= moving.at(-2)! && values.at(-1)! > moving.at(-1)!;
  }
  if (condition.type === "obv_confirmation") {
    const values = obv(candles);
    if (values.length <= condition.lookbackBars) return false;
    const before = values[values.length - 1 - condition.lookbackBars];
    const change = values.at(-1)! - before;
    const volumeBase = candles.slice(-condition.lookbackBars).reduce((sum, candle) => sum + candle.volume, 0);
    return volumeBase > 0 && change / volumeBase * 100 >= condition.minChangePercent;
  }
  if (condition.type === "break_fib_invalidation") {
    if (!impulse) return false;
    const level = impulse.high - (impulse.high - impulse.low) * condition.ratio;
    return current.close < level * (1 - (condition.bufferPercent ?? 0) / 100);
  }
  if (condition.type === "break_swing_low_invalidation") return !!impulse && current.close < impulse.low * (1 - (condition.bufferPercent ?? 0) / 100);
  if (condition.type === "bearish_volume_invalidation") {
    const baseline = average(candles.slice(Math.max(0, candles.length - 1 - condition.period), -1).map(c => c.volume));
    const bodyPercent = current.open > 0 ? (current.open - current.close) / current.open * 100 : 0;
    return current.close < current.open && bodyPercent >= condition.minBodyPercent && baseline !== undefined && current.volume >= baseline * condition.minRatio;
  }
  return false;
}

function isGroup(item: Condition | ConditionGroup): item is ConditionGroup { return "conditions" in item; }

export function evaluateConditionGroup(group: ConditionGroup, candles: Candle[], impulse: Impulse | undefined): boolean {
  if (group.enabled === false) return false;
  const active = group.conditions.filter(item => item.enabled !== false);
  if (!active.length) return false;
  const results = active.map(item => isGroup(item) ? evaluateConditionGroup(item, candles, impulse) : evaluateCondition(item, candles, impulse));
  if (group.mode === "all") return results.every(Boolean);
  if (group.mode === "any") return results.some(Boolean);
  return results.filter(Boolean).length >= Math.max(1, group.minMatches ?? 1);
}

export interface SymbolInput { symbol: SymbolRef; candles: Candle[] }
export interface BacktestResult { report: BacktestReport; trades: Trade[]; signals: Array<Signal & { symbol: SymbolRef }>; equity: EquityPoint[] }
interface ActiveTrade { trade: Trade; entryIndex: number; entries: number; impulse: Impulse }

function stopPrice(config: BacktestConfig, active: ActiveTrade) {
  const stop = config.exitConfig.stopLoss;
  if (stop.type === "percent") return active.trade.entryPrice * (1 - stop.value / 100);
  if (stop.type === "swing_low") return active.impulse.low * (1 - stop.bufferPercent / 100);
  return (active.impulse.high - (active.impulse.high - active.impulse.low) * stop.ratio) * (1 - (stop.bufferPercent ?? 0) / 100);
}

function targetPrice(config: BacktestConfig, active: ActiveTrade, stop: number) {
  const target = config.exitConfig.takeProfit;
  if (target.type === "percent") return active.trade.entryPrice * (1 + target.value / 100);
  if (target.type === "risk_reward") return active.trade.entryPrice + Math.max(0, active.trade.entryPrice - stop) * target.ratio;
  if (target.type === "previous_high") return active.impulse.high;
  return active.impulse.high - (active.impulse.high - active.impulse.low) * target.ratio;
}

function consecutiveLosses(trades: Trade[]) {
  let max = 0;
  let current = 0;
  for (const trade of trades) { current = (trade.netPnl ?? 0) <= 0 ? current + 1 : 0; max = Math.max(max, current); }
  return max;
}

export function runBacktest(config: BacktestConfig, inputs: SymbolInput[], onProgress?: (value: number) => void): BacktestResult {
  const initialCapital = config.executionConfig.initialCapital;
  let cash = initialCapital;
  let peak = cash;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  let syntheticBars = 0;
  let invalidBars = 0;
  let riskEvents = 0;
  let processed = 0;
  const totalBars = Math.max(1, inputs.reduce((sum, input) => sum + input.candles.length, 0));
  const trades: Trade[] = [];
  const signals: Array<Signal & { symbol: SymbolRef }> = [];
  const equityByTime = new Map<number, EquityPoint>();
  const activeTrades = new Map<string, ActiveTrade>();

  const enter = (symbol: SymbolRef, candle: Candle, index: number, impulse: Impulse, existing?: ActiveTrade) => {
    const sizing = config.positionConfig.sizing;
    const provisionalStop = existing ? stopPrice(config, existing) : candle.close * .9;
    const riskDistance = Math.max(Number.EPSILON, candle.close - provisionalStop);
    const amount = sizing.type === "fixed_amount" ? sizing.value : sizing.type === "fixed_percent" ? cash * sizing.value / 100 : Math.min(cash, cash * sizing.value / 100 * candle.close / riskDistance);
    const cappedAmount = Math.max(0, Math.min(cash, amount));
    if (!cappedAmount) return;
    const quantity = cappedAmount / candle.close;
    const entryFee = cappedAmount * config.executionConfig.feePercent / 100;
    const entrySlip = cappedAmount * config.executionConfig.slippagePercent / 100;
    const entryTax = cappedAmount * config.executionConfig.buyTaxPercent / 100;
    cash -= cappedAmount + entryFee + entrySlip + entryTax;
    if (existing) {
      const previousValue = existing.trade.entryPrice * existing.trade.quantity;
      existing.trade.entryPrice = (previousValue + cappedAmount) / (existing.trade.quantity + quantity);
      existing.trade.quantity += quantity;
      existing.trade.fees += entryFee;
      existing.trade.slippageCost += entrySlip;
      existing.trade.taxCost += entryTax;
      existing.entries++;
      const signal: Signal = { time: candle.time, price: candle.close, type: "add", quantity, reason: { conditionGroup: config.addConditionGroup ?? config.entryConditionGroup } };
      existing.trade.adds.push(signal);
      signals.push({ symbol, ...signal });
    } else {
      const trade: Trade = { symbol, entryTime: candle.time, entryPrice: candle.close, quantity, fees: entryFee, slippageCost: entrySlip, taxCost: entryTax, adds: [] };
      activeTrades.set(`${symbol.chain}:${symbol.pairId}`, { trade, entryIndex: index, entries: 1, impulse });
      signals.push({ symbol, time: candle.time, price: candle.close, type: "entry", quantity, reason: { impulse, conditionGroup: config.entryConditionGroup } });
    }
  };

  for (const input of inputs) {
    const normalized = normalizeCandles(input.candles, config.interval);
    syntheticBars += normalized.syntheticBars;
    invalidBars += normalized.invalidBars;
    const candles = normalized.candles;
    const key = `${input.symbol.chain}:${input.symbol.pairId}`;
    let entryWasMet = false;
    let addWasMet = false;
    for (let index = 0; index < candles.length; index++) {
      const candle = candles[index];
      const history = candles.slice(0, index + 1);
      const impulse = detectImpulse(history, config.impulseCondition);
      let active = activeTrades.get(key);
      if (active) {
        const stop = stopPrice(config, active);
        const target = targetPrice(config, active, stop);
        const invalidated = evaluateConditionGroup(config.invalidationConditionGroup, history, active.impulse);
        let exit: { price: number; type: Signal["type"] } | undefined;
        if (candle.open <= stop || candle.low <= stop) exit = { price: candle.open <= stop ? candle.open : stop, type: "stop_loss" };
        else if (invalidated) exit = { price: candle.close, type: "invalidation" };
        else if (target > active.trade.entryPrice && (candle.open >= target || candle.high >= target)) exit = { price: candle.open >= target ? candle.open : target, type: "take_profit" };
        else if (config.exitConfig.maxHoldingBars && index - active.entryIndex >= config.exitConfig.maxHoldingBars) exit = { price: candle.close, type: "timeout" };
        if (exit) {
          const trade = active.trade;
          const proceeds = trade.quantity * exit.price;
          const exitFee = proceeds * config.executionConfig.feePercent / 100;
          const exitSlip = proceeds * config.executionConfig.slippagePercent / 100;
          const exitTax = proceeds * config.executionConfig.sellTaxPercent / 100;
          trade.fees += exitFee;
          trade.slippageCost += exitSlip;
          trade.taxCost += exitTax;
          trade.exitTime = candle.time;
          trade.exitPrice = exit.price;
          trade.grossPnl = (exit.price - trade.entryPrice) * trade.quantity;
          trade.netPnl = trade.grossPnl - trade.fees - trade.slippageCost - trade.taxCost;
          trade.exitReason = exit.type;
          trade.holdingBars = index - active.entryIndex;
          cash += proceeds - exitFee - exitSlip - exitTax;
          signals.push({ symbol: input.symbol, time: candle.time, price: exit.price, type: exit.type, quantity: trade.quantity, reason: { priority: exit.type, stop, target } });
          trades.push(trade);
          activeTrades.delete(key);
          active = undefined;
          entryWasMet = true;
        }
      }

      if (active) {
        const addNow = evaluateConditionGroup(config.addConditionGroup ?? config.entryConditionGroup, history, active.impulse);
        if (config.positionConfig.mode === "pyramiding" && active.entries < config.positionConfig.maxEntries && addNow && !addWasMet) enter(input.symbol, candle, index, active.impulse, active);
        addWasMet = addNow;
      } else {
        const entryNow = !!impulse && evaluateConditionGroup(config.entryConditionGroup, history, impulse);
        const alreadyTraded = trades.some(trade => trade.symbol.chain === input.symbol.chain && trade.symbol.pairId === input.symbol.pairId);
        if (entryNow && !entryWasMet && (config.positionConfig.allowReentry || !alreadyTraded) && activeTrades.size < config.positionConfig.maxConcurrentPositions) enter(input.symbol, candle, index, impulse!);
        entryWasMet = entryNow;
        addWasMet = false;
      }

      const openValue = [...activeTrades.values()].reduce((sum, item) => sum + item.trade.entryPrice * item.trade.quantity, 0);
      const unrealized = [...activeTrades.values()].reduce((sum, item) => sum + (candle.close - item.trade.entryPrice) * item.trade.quantity, 0);
      const equityValue = cash + openValue + unrealized;
      peak = Math.max(peak, equityValue);
      const drawdown = peak - equityValue;
      maxDrawdown = Math.max(maxDrawdown, drawdown);
      maxDrawdownPercent = Math.max(maxDrawdownPercent, peak ? drawdown / peak * 100 : 0);
      equityByTime.set(candle.time, { time: candle.time, equity: equityValue, cash, unrealized });
      processed++;
      onProgress?.(Math.min(1, processed / totalBars));
    }
    const open = activeTrades.get(key);
    if (open && config.exitConfig.closeAtEnd && candles.length) {
      const last = candles.at(-1)!;
      const proceeds = open.trade.quantity * last.close;
      const exitFee = proceeds * config.executionConfig.feePercent / 100;
      const exitSlip = proceeds * config.executionConfig.slippagePercent / 100;
      const exitTax = proceeds * config.executionConfig.sellTaxPercent / 100;
      open.trade.fees += exitFee;
      open.trade.slippageCost += exitSlip;
      open.trade.taxCost += exitTax;
      open.trade.exitTime = last.time;
      open.trade.exitPrice = last.close;
      open.trade.grossPnl = (last.close - open.trade.entryPrice) * open.trade.quantity;
      open.trade.netPnl = open.trade.grossPnl - open.trade.fees - open.trade.slippageCost - open.trade.taxCost;
      open.trade.exitReason = "end_of_backtest";
      open.trade.holdingBars = candles.length - 1 - open.entryIndex;
      cash += proceeds - exitFee - exitSlip - exitTax;
      signals.push({ symbol: input.symbol, time: last.time, price: last.close, type: "end_of_backtest", quantity: open.trade.quantity, reason: { closeAtEnd: true } });
      trades.push(open.trade);
      activeTrades.delete(key);
    }
  }

  if (activeTrades.size) riskEvents += activeTrades.size;
  const wins = trades.filter(trade => (trade.netPnl ?? 0) > 0);
  const losses = trades.filter(trade => (trade.netPnl ?? 0) <= 0);
  const netPnl = trades.reduce((sum, trade) => sum + (trade.netPnl ?? 0), 0);
  const grossProfit = wins.reduce((sum, trade) => sum + (trade.netPnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + (trade.netPnl ?? 0), 0));
  const ids = [...new Set(trades.map(trade => `${trade.symbol.chain}:${trade.symbol.ca}:${trade.symbol.pairId}`))];
  const bySymbol = ids.map(id => {
    const symbolTrades = trades.filter(trade => `${trade.symbol.chain}:${trade.symbol.ca}:${trade.symbol.pairId}` === id);
    return { symbol: symbolTrades[0].symbol, trades: symbolTrades.length, netPnl: symbolTrades.reduce((sum, trade) => sum + (trade.netPnl ?? 0), 0), winRate: symbolTrades.filter(trade => (trade.netPnl ?? 0) > 0).length / symbolTrades.length };
  });
  const report: BacktestReport = { totalTrades: trades.length, wins: wins.length, losses: losses.length, winRate: trades.length ? wins.length / trades.length : 0, grossPnl: trades.reduce((sum, trade) => sum + (trade.grossPnl ?? 0), 0), netPnl, returnPercent: initialCapital ? netPnl / initialCapital * 100 : 0, profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit ? Infinity : 0, maxDrawdown, maxDrawdownPercent, maxConsecutiveLosses: consecutiveLosses(trades), averageHoldingBars: trades.length ? trades.reduce((sum, trade) => sum + (trade.holdingBars ?? 0), 0) / trades.length : 0, dataQuality: { syntheticBars, invalidBars, riskEvents }, bySymbol };
  return { report, trades, signals, equity: [...equityByTime.values()].sort((a, b) => a.time - b.time) };
}
