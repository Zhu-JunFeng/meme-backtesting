/** Explicit UI/API selections; legacy storage uses `all` for the two supported sources. */
export const LIVE_SIGNAL_SOURCES = ['fomo_new_project_expanded', 'top_cluster_first_buy'] as const;
export type LiveSignalSourceCode = typeof LIVE_SIGNAL_SOURCES[number];
export function liveSignalSources(legacy: string): LiveSignalSourceCode[] {
  if (legacy === 'all') return [...LIVE_SIGNAL_SOURCES];
  return LIVE_SIGNAL_SOURCES.filter(source => source === legacy);
}
export function normalizeLiveSources(values: unknown): LiveSignalSourceCode[] {
  if (!Array.isArray(values) || !values.length || values.some(value => !LIVE_SIGNAL_SOURCES.includes(value)))
    throw new Error('至少选择一个有效的信号来源');
  return LIVE_SIGNAL_SOURCES.filter(source => values.includes(source));
}
export function legacyLiveSource(values: unknown): string {
  const sources = normalizeLiveSources(values);
  return sources.length === LIVE_SIGNAL_SOURCES.length ? 'all' : sources[0];
}
