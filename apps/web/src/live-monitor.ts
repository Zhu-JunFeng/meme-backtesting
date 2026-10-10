import {liveSignalSources,selectedProjectSources,PROJECT_PROVIDERS} from '@meme/domain';
export const signalSourceOptions=[{label:'FOMO 新项目（扩大信号）',value:'fomo_new_project_expanded'},{label:'Top Cluster 首次买入',value:'top_cluster_first_buy'},{label:'FOMO 新上榜项目（fomo_trending_new_project）',value:'fomo_trending_new_project'}];
export const sourceText=(value:string)=>signalSourceOptions.find(x=>x.value===value)?.label??({wallet_buy:'钱包买入',xxyy_completed:'XXYY 项目发现',memeinfo:'MemeInfo 信号',wallet:'钱包买入',xxyy:'XXYY 项目列表',all:'全部来源'} as Record<string,string>)[value]??'未知来源';
export const runSourceText=(run:any)=>run.projectSources||run.project_sources?PROJECT_PROVIDERS.filter(p=>(run.projectSources??selectedProjectSources(run))[p].enabled).map(sourceText).join('、'):(run.signalSources??liveSignalSources(run.signal_source)).map(sourceText).join('、');
export const activeWatch=(w:any)=>['monitoring','recovering','pending_eviction'].includes(w.status);
export function monitoringRows(watches:any[],search:string,source:string|undefined,order:'asc'|'desc'){
 return watches.filter(w=>activeWatch(w)&&(!source||w.signal_source===source||w.matched_sources?.includes(source))&&(!search||`${w.ca} ${w.pair_id}`.toLowerCase().includes(search.trim().toLowerCase())))
  .sort((a,b)=>{const time=(Date.parse(a.created_at)||0)-(Date.parse(b.created_at)||0);return (order==='asc'?time:-time)||String(a.ca).localeCompare(String(b.ca));});
}
