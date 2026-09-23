import { normalizeEntrySignals, type DatasetConfig, type SymbolRef } from '@meme/domain';

/** Historical candles still update indicators. Only entry/add authorization is gated. */
export function createEntryGate(config: DatasetConfig) {
  const delay=Number((config as DatasetConfig & {minimumSignalAgeMinutes?:number}).minimumSignalAgeMinutes ?? 0);
  if(!Number.isFinite(delay)||delay<0||delay>1440)throw new Error('信号后等待时间必须在 0–1440 分钟之间');
  const signals=normalizeEntrySignals(config.entrySignals,config.symbols);
  if(delay>0&&!signals)throw new Error('信号后等待时间需要完整的外部信号快照');
  const key=(s:SymbolRef)=>JSON.stringify([s.chain.trim().toLowerCase(),s.ca.trim()]);
  const times=signals && new Map(signals.map(s=>[JSON.stringify([s.chain,s.ca]),s.signalTime]));
  return {
    // Candle timestamps denote opens. Strict > excludes equality and the straddling signal bucket.
    allows:(s:SymbolRef,time:number)=>!times || time>(times.get(key(s)) ?? Infinity)+delay*60000,
    evidence:(s:SymbolRef)=>times ? {monitoringSignal:{signalTime:times.get(key(s)),rule:'bar_open_strictly_after_signal',...(delay?{minimumSignalAgeMinutes:delay}:{}),history:'available_before_signal'}} : {},
  };
}
