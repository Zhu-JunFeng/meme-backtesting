import { createHash } from 'node:crypto';
import type { StrategyConfig, ConditionGroup, Condition } from '@meme/domain';
export const BATCH='fib-grid-20260920-v1';
export const SOURCES={sol:'b230568b-3783-4b66-9d03-f001b44903b2',robin:'7779b0ad-6bc8-4947-8687-e6a463c92245'};
export const BASE_VERSION='b71ca09e-190d-4c36-b6dd-ed0ae67586a7';
export function stable(value:any):string{return JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
export const digest=(value:any)=>createHash('sha256').update(stable(value)).digest('hex');
export function batchId(key:string){const h=createHash('sha256').update(BATCH+':'+key).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
const group=(mode:ConditionGroup['mode'],conditions:(Condition|ConditionGroup)[],minMatches?:number):ConditionGroup=>({mode,conditions,...(minMatches?{minMatches}:{})});
export function combinations(base:StrategyConfig){
 const fib:Condition={type:'fib_retracement',zoneLow:.618,zoneHigh:.786},percent:Condition={type:'percent_retracement',minPercent:30,maxPercent:50};
 const volume:Condition={type:'volume_contraction',period:10,maxRatio:.7},bull:Condition={type:'bullish_volume_confirmation',period:10,minRatio:1.5};
 const pattern:Condition={type:'candle_pattern',patterns:['hammer','bullish_engulfing','pin_bar','long_lower_wick']};
 const rsi:Condition={type:'rsi_recovery',period:14,oversold:30,recovery:35},ema=(period:number):Condition=>({type:'ema_reclaim',period}),obv:Condition={type:'obv_confirmation',lookbackBars:10,minChangePercent:0};
 const entries=[group('all',[fib]),structuredClone(base.entryConditionGroup),group('all',[fib,rsi,ema(9)]),group('all',[fib,group('at_least',[volume,pattern,obv],2)]),group('all',[percent,volume,bull]),group('all',[percent,group('any',[rsi,ema(21),obv])])];
 const stops:StrategyConfig['exitConfig']['stopLoss'][]=[{type:'percent',value:50},{type:'fib_level',ratio:.886,bufferPercent:2},{type:'swing_low',bufferPercent:2}];
 const targets:StrategyConfig['exitConfig']['takeProfit'][]=[{type:'percent',value:100},{type:'risk_reward',ratio:4},{type:'fib_target',ratio:.382},{type:'previous_high'}];
 const sizes:StrategyConfig['positionConfig']['sizing'][]=[{type:'fixed_amount',value:100},{type:'fixed_percent',value:.1},{type:'risk_percent',value:.1}];
 const rows:{number:number;key:string;strategy:StrategyConfig;checksum:string}[]=[];
 for(const [e,entry]of entries.entries())for(const[s,stop]of stops.entries())for(const[t,target]of targets.entries())for(const[z,size]of sizes.entries())for(const adds of [false,true])for(const lock of [false,true]){
  const strategy=structuredClone(base);strategy.entryConditionGroup=structuredClone(entry);
  strategy.invalidationConditionGroup=group('any',[{type:'break_fib_invalidation',ratio:.886,bufferPercent:0},{type:'break_swing_low_invalidation',bufferPercent:0},{type:'bearish_volume_invalidation',period:10,minRatio:2,minBodyPercent:20}]);
  strategy.addConditionGroup={mode:'all',enabled:false,conditions:[]};
  strategy.exitConfig={stopLoss:structuredClone(stop),takeProfit:structuredClone(target),maxHoldingBars:200,closeAtEnd:true,profitLock:{enabled:lock,tiers:structuredClone(base.exitConfig.profitLock!.tiers)}};
  strategy.positionConfig={mode:adds?'pyramiding':'single_entry',maxEntries:adds?2:1,maxConcurrentPositions:1,allowReentry:true,sizing:structuredClone(size)};
  rows.push({number:rows.length+1,key:`${'ABCDEF'[e]}-S${s+1}-T${t+1}-P${z+1}${adds?'a':'s'}-L${Number(lock)}`,strategy,checksum:digest(strategy)});
 }
 if(rows.length!==864||new Set(rows.map(r=>r.checksum)).size!==864)throw new Error('组合数或去重校验失败');
 return [{number:0,key:'CONTROL',strategy:structuredClone(base),checksum:digest(base)},...rows];
}
/** Six profiles and all stop/target/sizing types covered; plus controls for both chains. */
export const PILOTS=[0,1,179,357,535,713,864];
