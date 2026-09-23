export { generateStrategyDescription, DESCRIPTION_GENERATOR_VERSION } from './strategy-description.js';
export type { VersionDescription, RunStrategyDescription } from './strategy-description.js';
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
/** Earliest externally observed signal, in UTC epoch milliseconds. Applies to all pools of this CA. */
export interface EntrySignal extends CaRef { signalTime: number }
export interface ExternalSignal extends EntrySignal { id:string; signalSource:string; detailId?:string; sourceSignal?:Record<string,unknown>; provenance?:unknown[]; basis?:'snapshot'|'legacy_gate'|'supplemental' }
export interface PoolSnapshot extends SymbolRef { startTime: number | null; endTime: number | null; noData: boolean }
export interface DatasetSelection { symbols?: SymbolRef[]; cas?: CaRef[]; interval: Interval; valueType: ValueType; startTime?: string; endTime?: string; filters?: Record<string, unknown>; entrySignals?: EntrySignal[] }
export interface DatasetConfig {
  externalSignals?: ExternalSignal[];
  signalSelection?: { enabled:boolean; excluded:CaRef[]; noOpportunity:SymbolRef[] };
  symbols: SymbolRef[];
  interval: Interval;
  valueType: ValueType;
  startTime?: string;
  endTime?: string;
  pools?: PoolSnapshot[];
  selection?: DatasetSelection;
  trendInterval?: Interval;
  entryInterval?: Interval;
  entrySignals?: EntrySignal[];
}

/** Fail closed: an enabled gate must cover exactly the selected chain/CA set. */
export function normalizeEntrySignals(input: EntrySignal[] | undefined, refs: CaRef[]): EntrySignal[] | undefined {
  if (input === undefined) return;
  if (!Array.isArray(input) || !input.length || input.length > 10000) throw new Error('信号入场限制需要 1–10000 个有效信号');
  const key = (r: CaRef) => JSON.stringify([r.chain.trim().toLowerCase(), r.ca.trim()]);
  const expected = new Set(refs.map(key)), signals = new Map<string, EntrySignal>();
  for (const r of input) {
    if (!r || typeof r.chain !== 'string' || !r.chain.trim() || typeof r.ca !== 'string' || !r.ca.trim() || !Number.isSafeInteger(r.signalTime) || r.signalTime < 0 || r.signalTime > 8640000000000000) throw new Error('信号时间必须为合法毫秒时间戳，链和 CA 不能为空');
    const k = key(r);
    if (!expected.has(k)) throw new Error(`信号 CA 不在数据集中：${r.chain}/${r.ca}`);
    const old = signals.get(k);
    if (!old || r.signalTime < old.signalTime) signals.set(k, {chain:r.chain.trim().toLowerCase(), ca:r.ca.trim(), signalTime:r.signalTime});
  }
  if (signals.size !== expected.size) throw new Error('数据集存在缺少触发时间的 CA，禁止无信号买入');
  return [...signals.values()].sort((a,b)=>key(a).localeCompare(key(b)));
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
export interface ProfitLock { enabled: boolean; tiers: Array<{ activationPercent: number; floorPercent: number }> }
export function validateProfitLock(lock?: ProfitLock): string | undefined {
  if (lock === undefined) return;
  if (!lock || typeof lock.enabled !== 'boolean' || !Array.isArray(lock.tiers)) return '动态锁盈配置无效';
  if (!lock.enabled) return;
  if (!lock.tiers.length || lock.tiers.length > 50) return '动态锁盈需要 1–50 个档位';
  let activation = 0, floor = -1;
  for (const tier of lock.tiers) {
    if (!tier || !Number.isFinite(tier.activationPercent) || !Number.isFinite(tier.floorPercent) || tier.activationPercent <= activation || tier.floorPercent < 0 || tier.floorPercent <= floor || tier.floorPercent >= tier.activationPercent) return '锁盈激活比例必须递增，保底比例须非负、逐档递增且低于激活比例';
    activation = tier.activationPercent; floor = tier.floorPercent;
  }
}
export interface ExitConfig { stopLoss: StopLoss; takeProfit: TakeProfit; maxHoldingBars?: number; closeAtEnd: boolean; profitLock?: ProfitLock }
export interface ExecutionConfig { initialCapital: number; feePercent: number; slippagePercent: number; buyTaxPercent: number; sellTaxPercent: number; maxSlippagePercent?: number; fillMode: "current_bar_close" | "next_bar_open" }
export interface PositionConfig { mode: "single_entry" | "pyramiding"; maxEntries: number; maxConcurrentPositions: number; allowReentry: boolean; sizing: { type: "fixed_amount" | "fixed_percent" | "risk_percent"; value: number } }

export interface StrategyConfig {
  schemaVersion: 1;
  /** New tasks default true; never apply defaults inside historical engine restoration. */
  entryAfterSignal?: boolean;
  /** Optional minimum elapsed minutes after the earliest external signal. Entry bar open must be strictly later. */
  minimumSignalAgeMinutes?: number;
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

export type SignalType = "entry" | "add" | "take_profit" | "stop_loss" | "profit_lock" | "invalidation" | "timeout" | "end_of_backtest" | "risk_event";
export interface Signal { time: number; price: number; type: SignalType; reason: Record<string, unknown>; quantity?: number; tradeNo?: number; eventOrder?: number }
export interface Trade { symbol: SymbolRef; entryTime: number; entryPrice: number; quantity: number; exitTime?: number; exitPrice?: number; grossPnl?: number; fees: number; slippageCost: number; taxCost: number; netPnl?: number; exitReason?: string; holdingBars?: number; adds: Signal[]; tradeNo?: number; firstEntryPrice?: number; buyAmount?: number; buyFees?: number; buySlippageCost?: number; buyTaxCost?: number }
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
export interface StrategyVersion { id: string; templateId: string; version: number; schemaVersion: number; strategyJson: StrategyConfig; checksum: string; createdAt: string; versionDescription?: import('./strategy-description.js').VersionDescription | null }
