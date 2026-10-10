import type { Candle, ImpulseConfig } from '@meme/domain';
import type { Impulse } from './index.js';

export const IMPULSE_SELECTION_VERSION = 'pullback-v2' as const;
export const usesPullbackSelection = (config: ImpulseConfig) => config.selectionVersion === IMPULSE_SELECTION_VERSION;
type Pivots = { highPivots: number[]; lowPivots: number[] };

/** Absolute indices; end excludes future bars. Resumable callers supply incremental pivots.
 * Only flat-position callers advance the immutable pending candidate. */
export function advanceImpulseCandidate(history: Candle[], config: ImpulseConfig, pending?: Impulse,
  offset = 0, pivots?: Pivots, end = history.length): { impulse?: Impulse; changed: boolean } {
  const index = offset + end - 1;
  const first = Math.max(config.leftBars, index + 1 - config.lookbackBars, offset + config.leftBars);
  const last = index - config.rightBars;
  const at = (i: number) => history[i - offset];
  const close = end ? at(index).close : NaN;
  if (config.enabled !== false && pending && pending.lowIndex >= first && pending.highIndex <= last
    && pending.confirmedAtIndex <= index && close <= pending.high && close >= pending.low)
    return { impulse: pending, changed: false };
  const result = (impulse?: Impulse) => ({ impulse, changed: !!pending || !!impulse });
  if (config.enabled === false || end < config.leftBars + config.rightBars + 2) return result();
  let highs = pivots?.highPivots, lows = pivots?.lowPivots;
  if (!highs || !lows) {
    highs = []; lows = [];
    for (let p = first; p <= last; p++) {
      let high = true, low = true;
      for (let j = p - config.leftBars; j <= p + config.rightBars; j++) {
        high &&= at(p).high >= at(j).high; low &&= at(p).low <= at(j).low;
      }
      if (high) highs.push(p); if (low) lows.push(p);
    }
  }
  // Historical close extrema prevent invalidated pairs reviving after price returns inside.
  const maxClose: number[] = [], minClose: number[] = [];
  let max = -Infinity, min = Infinity;
  for (let j = index; j >= first; j--) {
    maxClose[j - first] = max; minClose[j - first] = min;
    max = Math.max(max, at(j).close); min = Math.min(min, at(j).close);
  }
  let lowest = Infinity; for (const l of lows) if (l >= first) lowest = Math.min(lowest, at(l).low);
  for (let h = highs.length - 1; h >= 0; h--) {
    const hi = highs[h]; if (hi < first || hi > last) continue;
    const high = at(hi).high;
    if (maxClose[hi - first] > high || (high / lowest - 1) * 100 < config.minGainPercent) continue;
    let rangeHigh = high, cursor = hi;
    for (let l = lows.length - 1; l >= 0; l--) {
      const lo = lows[l]; if (lo >= hi) continue;
      if (lo < first || hi - lo > config.maxDurationBars) break;
      while (cursor > lo) rangeHigh = Math.max(rangeHigh, at(--cursor).high);
      if (rangeHigh > high) break; // Extending left cannot remove an intervening higher high.
      const low = at(lo).low, gainPercent = (high / low - 1) * 100;
      if (low <= 0 || gainPercent < config.minGainPercent || minClose[hi - first] < low) continue;
      let volume = 0; for (let j = lo; j <= hi; j++) volume += at(j).volume;
      const averageVolume = volume / (hi - lo + 1);
      if (config.requireVolumeExpansion) {
        const begin = Math.max(0, lo - Math.max(5, config.leftBars * 2));
        if (begin < offset || begin === lo) continue;
        let baseline = 0; for (let j = begin; j < lo; j++) baseline += at(j).volume;
        if (averageVolume < baseline / (lo - begin) * (config.volumeExpansionRatio ?? 1.5)) continue;
      }
      const confirmed = hi + config.rightBars;
      return result({ low, high, lowIndex: lo, highIndex: hi, confirmedAtIndex: confirmed, gainPercent, averageVolume,
        lowTime: at(lo).time, highTime: at(hi).time, confirmedTime: at(confirmed).time,
        lowSynthetic: !!at(lo).synthetic, highSynthetic: !!at(hi).synthetic, confirmedSynthetic: !!at(confirmed).synthetic,
        selectionVersion: IMPULSE_SELECTION_VERSION });
    }
  }
  return result();
}
