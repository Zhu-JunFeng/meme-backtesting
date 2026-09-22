import { normalizeEntrySignals, type DatasetConfig, type SymbolRef } from '@meme/domain';

/** Historical candles still update indicators. Only entry/add authorization is gated. */
export function createEntryGate(config: DatasetConfig) {
  const signals=normalizeEntrySignals(config.entrySignals,config.symbols);
  const key=(s:SymbolRef)=>JSON.stringify([s.chain.trim().toLowerCase(),s.ca.trim()]);
  const times=signals && new Map(signals.map(s=>[JSON.stringify([s.chain,s.ca]),s.signalTime]));
  return {
    // Candle timestamps denote opens. Strict > excludes equality and the straddling signal bucket.
    allows:(s:SymbolRef,time:number)=>!times || time>(times.get(key(s)) ?? Infinity),
    evidence:(s:SymbolRef)=>times ? {monitoringSignal:{signalTime:times.get(key(s)),rule:'bar_open_strictly_after_signal',history:'available_before_signal'}} : {},
  };
}
