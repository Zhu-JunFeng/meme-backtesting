import type { Condition, ConditionGroup, ExecutionOverrides, StrategyConfig } from './index.js';

export interface VersionDescription { generatedText: string; notes: string; generatorVersion: number }
export interface RunStrategyDescription extends VersionDescription { version: number; executionOverrides: ExecutionOverrides }
export const DESCRIPTION_GENERATOR_VERSION = 1;
const patterns: Record<string,string> = {
  hammer:'锤子线（收盘≥开盘，下影≥实体2倍且≥振幅40%，上影≤振幅20%）',
  bullish_engulfing:'阳线吞没（前阴后阳，本根开盘≤前根收盘且本根收盘≥前根开盘）',
  pin_bar:'Pin Bar（下影≥振幅55%，实体≤振幅30%）',
  long_lower_wick:'长下影（下影≥实体2倍且≥振幅40%）'
};
function conditionText(c: Condition): string {
  try { switch(c.type) {
    case 'fib_retracement': return `收盘回撤比例在 ${c.zoneLow}–${c.zoneHigh}（含边界）；比例=(High−收盘)/(High−Low)`;
    case 'percent_retracement': return `收盘相对 Swing High 下跌 ${c.minPercent}%–${c.maxPercent}%（含边界）`;
    case 'volume_contraction': return `高点之后最近最多 ${c.period} 根的平均成交量 / 拉升段平均成交量 ≤ ${c.maxRatio}，且拉升均量>0`;
    case 'bullish_volume_confirmation': return `收盘>开盘，当前成交量≥此前最多 ${c.period} 根平均成交量的 ${c.minRatio} 倍（基准不含本根）`;
    case 'candle_pattern': return `以下形态任一满足：${c.patterns.map(p=>patterns[p] ?? p).join('；')}`;
    case 'rsi_recovery': return `${c.period} 根简单平均涨跌幅 RSI：上一根≤${c.oversold}，当前≥${c.recovery}（不是 Wilder 平滑 RSI）`;
    case 'ema_reclaim': return `EMA ${c.period}：前收盘≤前 EMA，当前收盘>当前 EMA；以首根收盘初始化`;
    case 'obv_confirmation': return `最近 ${c.lookbackBars} 根 OBV 增量 / 同段总成交量 ×100 ≥ ${c.minChangePercent}%，总量须>0`;
    case 'break_fib_invalidation': return `收盘严格跌破 Fib ${c.ratio} × (1−${c.bufferPercent ?? 0}%)`;
    case 'break_swing_low_invalidation': return `收盘严格跌破 Swing Low × (1−${c.bufferPercent ?? 0}%)`;
    case 'bearish_volume_invalidation': return `阴线实体跌幅≥${c.minBodyPercent}%，成交量≥此前最多 ${c.period} 根均量的 ${c.minRatio} 倍`;
    default: return `未支持执行的配置 ${c.type}；原始参数：${JSON.stringify(c)}`;
  } } catch { return `参数不完整，原始配置：${JSON.stringify(c)}`; }
}
function groupText(group: ConditionGroup, depth=0): string {
  const indent='  '.repeat(depth);
  const relation=group.mode==='all'?'全部满足':group.mode==='any'?'任一满足':`至少满足 ${group.minMatches ?? 1} 项`;
  return `${indent}${group.enabled===false?'[已禁用，不参与判断] ':''}${relation}（仅计已启用的直接子项；空组不触发）：\n`+
    (group.conditions ?? []).map(c=>'conditions' in c ? groupText(c as ConditionGroup,depth+1) : `${indent}  • ${c.enabled===false?'[已禁用] ':''}${conditionText(c)}`).join('\n');
}
/** Deterministic prose mirrors the current resumable engine, including existing limitations. */
export function generateStrategyDescription(s: StrategyConfig, notes=''): VersionDescription {
  if(typeof notes!=='string' || notes.length>20000) throw new Error('版本补充备注必须是最多 20000 字符的文本');
  const i=s.impulseCondition,p=s.positionConfig,e=s.exitConfig,c=s.executionConfig;
  const stop=e.stopLoss.type==='percent'?`当前加权平均买入值下方 ${e.stopLoss.value}%`:e.stopLoss.type==='swing_low'?`首次入场锁定的 Swing Low 下方 ${e.stopLoss.bufferPercent}%`:`首次入场锁定的 Fib ${e.stopLoss.ratio} 下方 ${e.stopLoss.bufferPercent ?? 0}%`;
  const target=e.takeProfit.type==='percent'?`当前加权平均买入值上方 ${e.takeProfit.value}%`:e.takeProfit.type==='risk_reward'?`当前均价 + max(0, 当前均价−基础止损值) × ${e.takeProfit.ratio}`:e.takeProfit.type==='previous_high'?'首次入场锁定的 Swing High':`首次入场锁定的 Fib ${e.takeProfit.ratio}`;
  const sizing=p.sizing.type==='fixed_amount'?`每次固定金额 ${p.sizing.value}`:p.sizing.type==='fixed_percent'?`每次使用当时剩余现金的 ${p.sizing.value}%（不是总权益比例）`:`每次按剩余现金的 ${p.sizing.value}% 估算风险金额。现有引擎首次入场使用收盘下方 10% 的估算距离，而非配置止损；加仓使用原持仓基础止损估算。计算金额不超过现金`;
  const parts=[
    `监控与回放\n${s.entryAfterSignal!==false?'仅在信号触发后买入：首次买入及加仓所在 K 线的开盘时间必须严格晚于该 CA 最早有效外部信号。等于信号时间、信号落在本根内部均不允许本根买入；缺失信号的 CA 全池排除，信号晚于行情末尾则没有买入机会。':'不限制信号前买入；外部信号仅用于展示。'}信号前已经存在的行情可用于指标预热。单周期按时间推进，仅使用当时已完成的数据；周期、链、CA 和时间范围由任务选择，不属于本版本。`,
    `拉升识别\n${i.enabled===false?'[已禁用，无法产生首次入场] ':''}Fractal Pivot 左侧 ${i.leftBars} 根、右侧 ${i.rightBars} 根确认；回看 ${i.lookbackBars} 根。先从最近已确认高点向前寻找，再从最近的先行低点向前匹配；低点须早于高点，跨度≤${i.maxDurationBars} 根，涨幅≥${i.minGainPercent}%。右侧 K 线完成后才能确认高点。${i.requireVolumeExpansion?`拉升段均量≥低点之前最多 ${Math.max(5,i.leftBars*2)} 根均量的 ${i.volumeExpansionRatio ?? 1.5} 倍，缺少基准量不通过。`:'不要求拉升放量。'}Fib 值=High−(High−Low)×比例；0 为高点，1 为低点。`,
    `首次入场\n${groupText(s.entryConditionGroup)}\n需要有效拉升；条件由不满足变为满足时尝试买入，持续满足不会逐根重复触发。持仓后锁定首次入场的拉升依据，不按后续新高低点替换。`,
    `失效判断\n${groupText(s.invalidationConditionGroup)}\n持仓时按上述组关系判断，不能将每个子条件都描述为独立退出原因。失效退出按本根收盘值成交，可能盈利也可能亏损。`,
    `仓位与加仓\n${sizing}；实际金额进一步受可用现金及买入成本限制，资金不足不会透支。所有池共享初始资金 ${c.initialCapital}，全任务最多同时持有 ${p.maxConcurrentPositions} 个池。${p.allowReentry?'平仓后允许该池再次入场，但仍要求新的条件触发边沿。':'每个池平仓后不再入场；不是按 CA 限制，多个池独立。'}${p.mode==='single_entry'?'持仓期间仅首次买入，忽略加仓。':`每段持仓最多 ${p.maxEntries} 次买入（含首次），加仓按数量更新加权平均成本；最多加仓 ${Math.max(0,p.maxEntries-1)} 次。加仓也仅在条件从不满足变为满足时触发。\n${s.addConditionGroup?`采用已配置的加仓条件组${s.addConditionGroup.enabled===false?'；当前引擎禁用组不触发加仓，不自动回退入场组':''}：\n${groupText(s.addConditionGroup)}`:`未配置加仓组，复用首次入场条件：\n${groupText(s.entryConditionGroup)}`}`}`,
    `退出规则\n基础止损：${stop}。止盈：${target}；目标必须高于当前均价才执行。止损/锁盈优先，其次失效、止盈、超时、结束平仓。跳空低开穿过止损线按开盘值退出，否则最低值触线按止损线退出；跳空高开超过有效止盈目标按开盘值退出，否则最高值触线按目标退出。${e.maxHoldingBars?`首次入场起持仓达到 ${e.maxHoldingBars} 根仍未退出则按收盘值超时退出；加仓不重置计时。`:'未启用持仓超时。'}${e.closeAtEnd?'每池数据末尾或任务截止的最后一根按收盘值结束平仓；末根新买入也会在同根结束平仓。':'数据结束不强制卖出，未平仓部分保留浮动盈亏。'}仅一次性退出，不分批止盈。`,
    `动态锁盈\n${e.profitLock?.enabled?`按加权平均成本计算、不含费用的收盘盈利达到门槛后，下一根才启用锁盈线，不用本根最高值激活。档位：${e.profitLock.tiers.map(t=>`盈利≥${t.activationPercent}% → 保底 ${t.floorPercent}%`).join('；')}。可一次跨越多档；激活后不失效，绝对锁盈值只能上移，加仓不能降低已生效线。止损取基础止损与锁盈线较高者；固定止盈仍有效，可能先于锁盈激活而退出。`:'未启用。'}`,
    `成交与成本\n${c.fillMode==='current_bar_close'?'首次买入、加仓按当前 K 线收盘值成交。':'下一根开盘模式仅预留，当前 API 不支持保存执行。'}手续费 ${c.feePercent}%，滑点 ${c.slippagePercent}%，买入税 ${c.buyTaxPercent}%，卖出税 ${c.sellTaxPercent}%。成本按对应成交金额单独扣除；滑点记作成本，不直接改变事件标注的成交值。${c.maxSlippagePercent!==undefined?`maxSlippagePercent=${c.maxSlippagePercent} 为预留值，当前引擎不使用。`:''}同一时间先处理全部池退出，再按链、CA、池固定顺序处理加仓及首次入场。缺口沿用上一收盘、零成交量的补齐规则，补齐 K 线也参与计算。上述为版本默认值，任务运行覆盖项另行展示；不保证盈利。`
  ];
  return {generatedText:parts.join('\n\n'), notes, generatorVersion:DESCRIPTION_GENERATOR_VERSION};
}
