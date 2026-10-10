import {normalizeLiveSources,selectedLiveSources,type LiveSignalSourceCode} from './live-sources.js';

export const SOURCE_WALLETS = ['5aLY85pyxiuX3fd4RgM3Yc1e3MAL6b7UgaZz6MS3JUfG','7BNaxx6KdUYrjACNQZ9He26NBFoFxujQMAfNLnArLGH5'] as const;
export const PROJECT_PROVIDERS = ['memeinfo','wallet','xxyy'] as const;
export type ProjectProvider = typeof PROJECT_PROVIDERS[number];
export type SourceRule = {enabled:boolean;minMarketCap:number;exitMarketCap:number;maxAgeMinutes?:number;minKol?:number;signalSources?:LiveSignalSourceCode[]};
export type ProjectSources = {version:1;memeinfo:SourceRule;wallet:SourceRule;xxyy:SourceRule};
export function defaultProjectSources(signals:LiveSignalSourceCode[]=['fomo_new_project_expanded']):ProjectSources {
 return {version:1,memeinfo:{enabled:true,minMarketCap:50000,exitMarketCap:50000,signalSources:signals},wallet:{enabled:false,minMarketCap:20000,exitMarketCap:20000,maxAgeMinutes:30},xxyy:{enabled:false,minMarketCap:30000,exitMarketCap:30000,maxAgeMinutes:120,minKol:2}};
}
export function normalizeProjectSources(input:unknown,chain:string):ProjectSources {
 const x=input as ProjectSources;
 if(!x||x.version!==1)throw new Error('项目来源配置版本无效');
 const result=defaultProjectSources();
 for(const p of PROJECT_PROVIDERS){
  const r=x[p];if(!r||typeof r.enabled!=='boolean'||!Number.isFinite(r.minMarketCap)||r.minMarketCap<=0||!Number.isFinite(r.exitMarketCap)||r.exitMarketCap<=0||r.exitMarketCap>r.minMarketCap)throw new Error('入组／剔除市值无效，剔除市值须不高于入组市值');
  if(p!=='memeinfo'&&r.enabled&&chain!=='sol')throw new Error('钱包和 XXYY 来源目前仅支持 SOL');
  result[p]={enabled:r.enabled,minMarketCap:r.minMarketCap,exitMarketCap:r.exitMarketCap};
  if(p==='memeinfo')result[p].signalSources=normalizeLiveSources(r.signalSources);
  else {if(!Number.isFinite(r.maxAgeMinutes)||r.maxAgeMinutes!<=0||r.maxAgeMinutes!>43200)throw new Error('项目年龄须大于 0 且不超过 43200 分钟');result[p].maxAgeMinutes=r.maxAgeMinutes;}
  if(p==='xxyy'){if(!Number.isInteger(r.minKol)||r.minKol!<0||r.minKol!>100000)throw new Error('最低 KOL 数无效');result[p].minKol=r.minKol;}
 }
 if(!PROJECT_PROVIDERS.some(p=>result[p].enabled))throw new Error('至少选择一个项目来源');
 return result;
}
export function selectedProjectSources(run:{project_sources?:ProjectSources|null;signal_source?:string;signal_sources?:string[]|null;chain?:string}):ProjectSources {
 return run.project_sources??defaultProjectSources(selectedLiveSources({...run,signal_source:run.signal_source??'all'}));
}
export function qualifiesSource(provider:ProjectProvider,rule:SourceRule,facts:{marketCap?:number;createdAt?:number;kol?:number;dexId?:string},now:number):boolean {
 if(!rule.enabled||!Number.isFinite(facts.marketCap))return false;
 if(provider==='memeinfo')return facts.marketCap!>=rule.minMarketCap;
 if(facts.marketCap!<=rule.minMarketCap||!Number.isSafeInteger(facts.createdAt)||facts.createdAt!<=0||facts.createdAt!>now||now-facts.createdAt!>=rule.maxAgeMinutes!*60000)return false;
 return provider!=='xxyy'||(facts.dexId==='pfamm'&&Number.isInteger(facts.kol)&&facts.kol!>=rule.minKol!);
}
export function effectiveExitCap(config:ProjectSources,matched:ProjectProvider[]):number {
 return Math.min(...(matched.length?matched:['memeinfo' as const]).map(p=>config[p].exitMarketCap));
}
export function feedQuery(configs:ProjectSources[]){
 const rules=configs.filter(c=>c.xxyy.enabled).map(c=>c.xxyy);
 if(!rules.length)return null;
 return {createTime:`0,${Math.max(...rules.map(r=>r.maxAgeMinutes!))}`,mc:`${Math.min(...rules.map(r=>r.minMarketCap))},`,kol:`${Math.min(...rules.map(r=>r.minKol!))},`,dex:['pump']};
}
