/** Legacy `all` permanently means the original two sources, never future opt-ins. */
export const LIVE_SIGNAL_SOURCES = ['fomo_new_project_expanded', 'top_cluster_first_buy', 'fomo_trending_new_project'] as const;
export type LiveSignalSourceCode = typeof LIVE_SIGNAL_SOURCES[number];
export function liveSignalSources(legacy: string): LiveSignalSourceCode[] {
  if (legacy === 'all') return ['fomo_new_project_expanded', 'top_cluster_first_buy'];
  return LIVE_SIGNAL_SOURCES.filter(source => source === legacy);
}
export function normalizeLiveSources(values: unknown): LiveSignalSourceCode[] {
  if (!Array.isArray(values) || !values.length || values.some(value => !LIVE_SIGNAL_SOURCES.includes(value)))
    throw new Error('至少选择一个有效的信号来源');
  return LIVE_SIGNAL_SOURCES.filter(source => values.includes(source));
}
export function legacyLiveSource(values: unknown): string {
  const sources = normalizeLiveSources(values);
  return sources.length > 1 ? 'all' : sources[0];
}
/** Nullable array allows old API instances to finish requests during rolling deployment. */
export function selectedLiveSources(run:{signal_source:string;signal_sources?:string[]|null}):LiveSignalSourceCode[]{
 return run.signal_sources==null?liveSignalSources(run.signal_source):normalizeLiveSources(run.signal_sources);
}
