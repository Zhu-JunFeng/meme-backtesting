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

export interface SymbolRef { chain: string; ca: string; pairId: string }
export interface CaRef { chain: string; ca: string }
export interface PoolSnapshot extends SymbolRef { startTime: number | null; endTime: number | null; noData: boolean }
export interface DatasetSelection { symbols?: SymbolRef[]; cas?: CaRef[]; interval: Interval; valueType: ValueType; startTime?: string; endTime?: string; filters?: Record<string, unknown> }
export interface DatasetConfig {
  symbols: SymbolRef[];
  interval: Interval;
  valueType: ValueType;
  startTime?: string;
  endTime?: string;
  pools?: PoolSnapshot[];
  selection?: DatasetSelection;
  trendInterval?: Interval;
  entryInterval?: Interval;
}

export interface BaseCondition { enabled?: boolean }
export interface FibRetracementCondition extends BaseCondition { type: "fib_retracement"; zoneLow: number; zoneHigh: number }
export interface PercentRetracementCondition extends BaseCondition { type: "percent_retracement"; minPercent: number; maxPercent: number }
export interface VolumeContractionCondition extends BaseCondition { type: "volume_contraction"; period: number; maxRatio: number }
export interface BullishVolumeCondition extends BaseCondition { type: "bullish_volume_confirmation"; period: number; minRatio: number }
export interface CandlePatternCondition extends BaseCondition { type: "candle_pattern"; patterns: Array<"hammer" | "bullish_engulfing" | "pin_bar" | "long_lower_wick"> }
export interface RsiRecoveryCondition extends BaseCondition { type: "rsi_recovery"; period: number; oversold: number; recovery: number }
export interface EmaReclaimCondition extends BaseCondition { type: "ema_reclaim"; period: number }
export interface ObvConfirmationCondition extends BaseCondition { type: "obv_confirmation"; lookbackBars: number; minChangePercent: number }
export interface BreakFibInvalidation extends BaseCondition { type: "break_fib_invalidation"; ratio: number; bufferPercent?: number }
export interface BreakSwingLowInvalidation extends BaseCondition { type: "break_swing_low_invalidation"; bufferPercent?: number }
export interface BearishVolumeInvalidation extends BaseCondition { type: "bearish_volume_invalidation"; period: number; minRatio: number; minBodyPercent: number }
export interface UnavailableDataCondition extends BaseCondition { type: "liquidity_drop" | "holder_change" | "top10_concentration" | "bundle_wallet" | "liquidity_lock"; [key: string]: unknown }

export type Condition = FibRetracementCondition | PercentRetracementCondition | VolumeContractionCondition | BullishVolumeCondition | CandlePatternCondition | RsiRecoveryCondition | EmaReclaimCondition | ObvConfirmationCondition | BreakFibInvalidation | BreakSwingLowInvalidation | BearishVolumeInvalidation | UnavailableDataCondition;
export interface ConditionGroup {
  mode: "all" | "any" | "at_least";
  minMatches?: number;
  enabled?: boolean;
  conditions: Array<Condition | ConditionGroup>;
}

export interface ImpulseConfig {
  type: "impulse_fractal_swing";
  enabled?: boolean;
  leftBars: number;
  rightBars: number;
  lookbackBars: number;
  minGainPercent: number;
  maxDurationBars: number;
  requireVolumeExpansion: boolean;
  volumeExpansionRatio?: number;
}

export type StopLoss =
  | { type: "percent"; value: number }
  | { type: "fib_level"; ratio: number; bufferPercent?: number }
  | { type: "swing_low"; bufferPercent: number };
export type TakeProfit =
  | { type: "percent"; value: number }
  | { type: "risk_reward"; ratio: number }
  | { type: "fib_target"; ratio: number }
  | { type: "previous_high" };
export interface ExitConfig { stopLoss: StopLoss; takeProfit: TakeProfit; maxHoldingBars?: number; closeAtEnd: boolean }
export interface ExecutionConfig { initialCapital: number; feePercent: number; slippagePercent: number; buyTaxPercent: number; sellTaxPercent: number; maxSlippagePercent?: number; fillMode: "current_bar_close" | "next_bar_open" }
export interface PositionConfig { mode: "single_entry" | "pyramiding"; maxEntries: number; maxConcurrentPositions: number; allowReentry: boolean; sizing: { type: "fixed_amount" | "fixed_percent" | "risk_percent"; value: number } }

export interface StrategyConfig {
  schemaVersion: 1;
  impulseCondition: ImpulseConfig;
  entryConditionGroup: ConditionGroup;
  invalidationConditionGroup: ConditionGroup;
  addConditionGroup?: ConditionGroup;
  exitConfig: ExitConfig;
  positionConfig: PositionConfig;
  executionConfig: ExecutionConfig;
}

export interface BacktestConfig extends StrategyConfig, DatasetConfig { name: string; strategyTemplateId?: string | null; strategyVersionId?: string | null }
export interface ExecutionOverrides { initialCapital?: number; feePercent?: number; slippagePercent?: number; buyTaxPercent?: number; sellTaxPercent?: number }
export interface CreateBacktestRequest { name: string; strategyVersionId: string; dataset: DatasetSelection; executionOverrides?: ExecutionOverrides }

export type SignalType = "entry" | "add" | "take_profit" | "stop_loss" | "invalidation" | "timeout" | "end_of_backtest" | "risk_event";
export interface Signal { time: number; price: number; type: SignalType; reason: Record<string, unknown>; quantity?: number }
export interface Trade { symbol: SymbolRef; entryTime: number; entryPrice: number; quantity: number; exitTime?: number; exitPrice?: number; grossPnl?: number; fees: number; slippageCost: number; taxCost: number; netPnl?: number; exitReason?: string; holdingBars?: number; adds: Signal[] }
export interface EquityPoint { time: number; equity: number; cash: number; unrealized: number }
export interface BacktestReport { engineVersion?: string; unrealizedPnl?: number; totalNetPnl?: number; finalEquity?: number; openPositions?: Array<{ symbol: SymbolRef; quantity: number; lastPrice: number; netPnl: number; fees: number }> }
export interface BacktestReport { totalTrades: number; wins: number; losses: number; winRate: number; grossPnl: number; netPnl: number; returnPercent: number; profitFactor: number; maxDrawdown: number; maxDrawdownPercent: number; maxConsecutiveLosses: number; averageHoldingBars: number; dataQuality: { syntheticBars: number; invalidBars: number; riskEvents: number }; bySymbol: Array<{ symbol: SymbolRef; trades: number; netPnl: number; winRate: number }> }

export interface ConditionDefinition {
  id: string;
  code: string;
  name: string;
  category: string;
  description: string;
  parameterSchema: Record<string, unknown>;
  defaultParameters: Record<string, unknown>;
  implementationVersion: string;
  enabled: boolean;
  dataRequirements: string[];
}

export interface StrategyTemplateSummary { id: string; name: string; description: string; status: "draft" | "active" | "archived"; currentVersionId: string | null; currentVersion?: number; createdAt: string; updatedAt: string }
export interface StrategyVersion { id: string; templateId: string; version: number; schemaVersion: number; strategyJson: StrategyConfig; checksum: string; createdAt: string }
