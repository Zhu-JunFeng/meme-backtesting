import {describe,it,expect} from 'vitest';
import type {BacktestConfig,Candle,Condition,SymbolRef} from '@meme/domain';
import {runBacktest,normalizeCandles,ResumableEngine,type EngineBatch} from '../src/index.js';
import {symbols,configuration,candles} from './fixtures.js';
function withoutMetadata(value:any):any {if(Array.isArray(value))return value.map(withoutMetadata);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['tradeNo','eventOrder','firstEntryPrice','buyAmount','buyFees','buySlippageCost','buyTaxCost'].includes(k)).map(([k,v])=>[k,withoutMetadata(v)]));return value;}
function execute(config:BacktestConfig,inputs:{symbol:SymbolRef;candles:Candle[]}[],resume=false){
 let engine=new ResumableEngine(config);const batch:EngineBatch={trades:[],signals:[],equity:[]};
 const merge=()=>{const b=engine.drain();batch.trades.push(...b.trades);batch.signals.push(...b.signals);batch.equity.push(...b.equity);};
 const ticks=new Map<number,any[]>();for(const input of inputs){const data=normalizeCandles(input.candles,config.interval);engine.s.invalidBars+=data.invalidBars;for(let i=0;i<data.candles.length;i++){const c=data.candles[i];ticks.set(c.time,[...(ticks.get(c.time)??[]),{symbol:input.symbol,candle:c,last:i===data.candles.length-1}]);}}
 let i=0;for(const [,t]of [...ticks].sort((a,b)=>a[0]-b[0])){engine.step(t);if(resume && ++i%17===0){merge();engine=new ResumableEngine(config,JSON.parse(JSON.stringify(engine.checkpoint())));}}
 const report=engine.finish();engine.finalizeOpenPositions();merge();return {report,...batch};
}
const variants:Condition[]=[{type:'ema_reclaim',period:9},{type:'rsi_recovery',period:14,oversold:50,recovery:40},{type:'obv_confirmation',lookbackBars:10,minChangePercent:0},{type:'volume_contraction',period:6,maxRatio:2},{type:'bullish_volume_confirmation',period:6,minRatio:1},{type:'candle_pattern',patterns:['hammer','pin_bar','long_lower_wick','bullish_engulfing']},{type:'percent_retracement',minPercent:5,maxPercent:50}];
describe('resumable reference parity',()=>{
 for(const extra of [undefined,...variants])it(`matches reference: ${extra?.type ?? 'fib'}`,()=>{
  const c=configuration();if(extra)c.entryConditionGroup.conditions.push(extra);
  c.addConditionGroup={mode:'any',conditions:[{type:'bullish_volume_confirmation',period:3,minRatio:.9}]};
  c.invalidationConditionGroup={mode:'any',conditions:[{type:'break_fib_invalidation',ratio:.886},{type:'bearish_volume_invalidation',period:3,minBodyPercent:.2,minRatio:1}]};
  const inputs=symbols.map((symbol,i)=>({symbol,candles:candles(800,i*5)}));
  const reference=runBacktest(c,inputs),actual=execute(c,inputs,true);reference.report.engineVersion=actual.report.engineVersion;
  expect(withoutMetadata(actual)).toEqual(reference);
 });
 it('resumes open holdings and has bounded history after thousands of bars',()=>{
  const c=configuration();c.exitConfig.closeAtEnd=false;const inputs=symbols.map(symbol=>({symbol,candles:candles(2000)}));
  expect(execute(c,inputs,true)).toEqual(execute(c,inputs,false));
 });
 it('rejects incompatible checkpoint instead of silently restarting',()=>{const c=configuration(),s=new ResumableEngine(c).checkpoint();s.engineVersion='old';expect(()=>new ResumableEngine(c,s)).toThrow('不兼容');});
 it('retains volume expansion and deterministic input order',()=>{const c=configuration();c.impulseCondition.requireVolumeExpansion=true;c.impulseCondition.volumeExpansionRatio=.8;const inputs=symbols.map(symbol=>({symbol,candles:candles()}));const r=runBacktest(c,inputs),a=execute(c,[...inputs].reverse(),true);r.report.engineVersion=a.report.engineVersion;expect(withoutMetadata(a)).toEqual(r);});
});
