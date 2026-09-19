export type Interval = "30s" | "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type ValueType = "price" | "mcap";

export interface Candle {
  time: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  synthetic?: boolean;
  valid?: boolean;
  invalidReason?: string;
}

export type Comparison = "gt" | "gte" | "lt" | "lte" | "crossUp" | "crossDown" | "above" | "below";
export interface RsiCondition { type: "rsi"; period: number; operator: Comparison; value: number }
export interface MovingAverageCondition { type: "sma" | "ema"; period: number; source: keyof Pick<Candle,"open"|"high"|"low"|"close">; operator: Comparison; value?: number }
export interface VolumeRatioCondition { type: "volume_ratio"; period: number; operator: "gt" | "lt"; value: number }
export interface CandlePatternCondition { type: "candle_pattern"; pattern: "hammer" | "bullish_engulfing" | "long_lower_wick" | "bullish_volume" }
export interface FibonacciCondition { type: "fib_retracement"; impulseMinPercent: number; maxBars: number; zoneLow: number; zoneHigh: number; requireVolumeContraction?: boolean; volumeRatioMax?: number; confirmationPatterns?: CandlePatternCondition["pattern"][] }
export type IndicatorConfig = RsiCondition | MovingAverageCondition | VolumeRatioCondition | CandlePatternCondition | FibonacciCondition;
export interface ConditionGroup { logic: "AND" | "OR"; conditions: Array<IndicatorConfig | ConditionGroup> }

export type StopLoss = { type: "percent"; value: number } | { type: "fib_level"; ratio: number } | { type: "swing_low"; bufferPercent: number };
export type TakeProfit = { type: "percent"; value: number } | { type: "risk_reward"; ratio: number } | { type: "trailing_percent"; value: number };
export interface ExitConfig { stopLoss: StopLoss; takeProfit: TakeProfit; maxHoldingBars?: number; closeAtEnd: boolean }
export interface ExecutionConfig { feePercent: number; slippagePercent: number; buyTaxPercent: number; sellTaxPercent: number; maxSlippagePercent?: number; fillMode: "next_bar_open" | "next_bar_close" }
export interface PositionConfig { mode: "single_entry" | "pyramiding"; maxEntries: number; maxConcurrentPositions: number; allowReentry: boolean; sizing: { type: "fixed_amount" | "fixed_percent" | "risk_percent"; value: number } }
export interface SymbolRef { chain: string; ca: string; pairId: string }
export interface BacktestConfig { name: string; initialCapital: number; symbols: SymbolRef[]; interval: Interval; valueType: ValueType; startTime: string; endTime: string; entryConditions: ConditionGroup; exitConfig: ExitConfig; executionConfig: ExecutionConfig; positionConfig: PositionConfig }
export type SignalType = "entry" | "add" | "take_profit" | "stop_loss" | "timeout" | "end_of_backtest" | "risk_event";
export interface Signal { time: number; price: number; type: SignalType; reason: Record<string, unknown>; quantity?: number }
export interface Trade { symbol: SymbolRef; entryTime: number; entryPrice: number; quantity: number; exitTime?: number; exitPrice?: number; grossPnl?: number; fees: number; slippageCost: number; taxCost: number; netPnl?: number; exitReason?: string; holdingBars?: number; adds: Signal[] }
export interface EquityPoint { time: number; equity: number; cash: number; unrealized: number }
export interface BacktestReport { totalTrades: number; wins: number; losses: number; winRate: number; grossPnl: number; netPnl: number; returnPercent: number; profitFactor: number; maxDrawdown: number; maxDrawdownPercent: number; maxConsecutiveLosses: number; averageHoldingBars: number; dataQuality: { syntheticBars: number; invalidBars: number; riskEvents: number }; bySymbol: Array<{ symbol: SymbolRef; trades: number; netPnl: number; winRate: number }> }
