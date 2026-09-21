import type { Candle, Condition, ConditionGroup } from '@meme/domain';
import { evaluateCondition, type Impulse } from './index.js';

export const invalidationCodes = ['break_fib_invalidation', 'break_swing_low_invalidation', 'bearish_volume_invalidation', 'other_condition', 'unknown'] as const;
export type InvalidationCode = typeof invalidationCodes[number];
export interface InvalidationDetail {
  version: 1;
  source: 'signal_snapshot' | 'frozen_input' | 'unavailable';
  primary: InvalidationCode;
  message?: string;
  group?: ConditionGroup;
  matches: Array<{ code: InvalidationCode; path: number[]; parameters: Condition; observed: Record<string, number>; thresholds: Record<string, number> }>;
}
export const unavailableInvalidation = (message: string): InvalidationDetail => ({ version: 1, source: 'unavailable', primary: 'unknown', matches: [], message });
const isGroup = (node: Condition | ConditionGroup): node is ConditionGroup => 'conditions' in node;

/** Evidence only: does not choose exits or change the condition evaluator. Failed nested branches are excluded. */
export function describeInvalidation(group: ConditionGroup, candles: Candle[], impulse?: Impulse,
  test: (condition: Condition) => boolean = c => evaluateCondition(c, candles, impulse)): InvalidationDetail {
  const current = candles.at(-1);
  if (!current) return unavailableInvalidation('没有退出 K 线');
  const visit = (node: Condition | ConditionGroup, path: number[]): InvalidationDetail['matches'] | null => {
    if (node.enabled === false) return null;
    if (isGroup(node)) {
      const active = node.conditions.map((c, i) => ({ c, i })).filter(({ c }) => c.enabled !== false);
      const results = active.map(({ c, i }) => visit(c, [...path, i]));
      const count = results.filter(r => r !== null).length;
      const met = active.length > 0 && (node.mode === 'all' ? count === active.length : node.mode === 'any' ? count > 0 : count >= Math.max(1, node.minMatches ?? 1));
      return met ? results.flatMap(r => r ?? []) : null;
    }
    if (!test(node)) return null;
    const observed: Record<string, number> = { close: current.close }, thresholds: Record<string, number> = {};
    let code: InvalidationCode = 'other_condition';
    if (node.type === 'break_fib_invalidation' && impulse) {
      code = node.type; observed.swingLow = impulse.low; observed.swingHigh = impulse.high;
      thresholds.fibLevel = impulse.high - (impulse.high - impulse.low) * node.ratio;
      thresholds.closeBelow = thresholds.fibLevel * (1 - (node.bufferPercent ?? 0) / 100);
    } else if (node.type === 'break_swing_low_invalidation' && impulse) {
      code = node.type; observed.swingLow = impulse.low;
      thresholds.closeBelow = impulse.low * (1 - (node.bufferPercent ?? 0) / 100);
    } else if (node.type === 'bearish_volume_invalidation') {
      code = node.type;
      const previous = candles.slice(Math.max(0, candles.length - 1 - node.period), -1);
      const baseline = previous.reduce((sum, c) => sum + c.volume, 0) / previous.length;
      Object.assign(observed, { open: current.open, volume: current.volume, bodyPercent: (current.open - current.close) / current.open * 100, baselineVolume: baseline });
      Object.assign(thresholds, { minBodyPercent: node.minBodyPercent, minVolume: baseline * node.minRatio });
    }
    return [{ code, path, parameters: structuredClone(node), observed, thresholds }];
  };
  const matches = visit(group, []);
  if (!matches?.length) return unavailableInvalidation('退出条件无法核验，不推测细分原因');
  return { version: 1, source: 'signal_snapshot', primary: matches[0].code, matches, group: structuredClone(group) };
}
