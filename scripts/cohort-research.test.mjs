import {test} from 'node:test';
import assert from 'node:assert/strict';
import {earliestSignals,partitionDays,dateNumber,subsets,stability,eligible,evaluateCohort,research} from './cohort-research.mjs';
import {requireFinishedImport,importComplete,snapshot,fileHash} from './cohort-snapshot.mjs';
import {compareResult,deterministicId} from './cohort-server-verify.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runBacktest,ResumableEngine} from '../packages/engine/dist/index.js';
const DAY=86400000,base=Date.parse('2026-09-01T00:00:00+08:00');
test('Beijing midnight and earliest multi-pool signal remain one CA cohort',()=>{
 assert.equal(dateNumber(base-1)+1,dateNumber(base));
 const signals=earliestSignals([{chain:'sol',ca:'A',signal_time:base+DAY},{chain:'sol',ca:'A',signal_time:base},...Array.from({length:4},(_,i)=>({chain:'sol',ca:String(i),signalTime:base+(i+1)*DAY}))]);
 assert.equal(signals.length,5);assert.equal(signals[0].signalTime,base);const p=partitionDays(signals);assert(p.eligible);assert.deepEqual(p.entries.map(e=>e.fold),[1,2,3,4,5]);
});
test('fixed calendar blocks preserve empty dates; insufficient folds never qualify',()=>{
 const p=partitionDays([{chain:'bsc',ca:'a',signalTime:base},{chain:'bsc',ca:'b',signalTime:base+9*DAY}]);
 assert.equal(p.eligible,false);assert.deepEqual(p.folds.map(f=>f.toDay-f.fromDay),[2,2,2,2,2]);assert.deepEqual(p.entries.map(e=>e.fold),[1,5]);
});
test('stability uses positive returns, 20 trades, 10% drawdown and median deviation',()=>{
 const row=v=>({accountReturn:v,totalTrades:20,accountMaxDrawdown:10});
 assert(stability([row(1),row(1),row(1),row(1.5)],row(2)).pass);
 assert(!stability([row(1),row(1),row(1),row(1.51)],row(2)).pass);
 assert(!eligible({...row(1),totalTrades:19}));assert(!eligible(row(0)));assert(!eligible({...row(1),accountMaxDrawdown:10.01}));
 assert(!stability([row(1),row(1),row(1),row(1)],row(-1)).pass);
 assert.equal(subsets(5).length,31);assert.equal(new Set(subsets(5).map(JSON.stringify)).size,31);
});
test('refuses a snapshot until import has a terminal summary',()=>{
 assert.equal(importComplete(''),false);assert.equal(importComplete('{"kind":"project"}\n'),false);assert.equal(importComplete('{"kind":'),false);
 assert.equal(importComplete('{"kind":"summary"}\n'),true);
 assert.throws(()=>requireFinishedImport('{"kind":"start"}\n{"kind":"project"}'));
 assert(requireFinishedImport('{"kind":"start"}\n{"kind":"summary"}').summary);
});
function fixture(){
 const signals=Array.from({length:5},(_,i)=>({chain:'sol',ca:String(i),signalTime:base+i*DAY}));
 const symbols=signals.slice(0,2).map(s=>({chain:s.chain,ca:s.ca,pairId:s.ca}));
 const config={schemaVersion:1,name:'cohort',symbols,interval:'30s',valueType:'mcap',entryAfterSignal:true,entrySignals:signals.slice(0,2),
 impulseCondition:{type:'impulse_fractal_swing',leftBars:2,rightBars:2,lookbackBars:30,minGainPercent:10,maxDurationBars:20,requireVolumeExpansion:false},
 entryConditionGroup:{mode:'all',conditions:[{type:'fib_retracement',zoneLow:.2,zoneHigh:.8}]},invalidationConditionGroup:{enabled:false,mode:'any',conditions:[]},
 exitConfig:{stopLoss:{type:'percent',value:99},takeProfit:{type:'percent',value:10000},closeAtEnd:true},
 executionConfig:{initialCapital:1000,feePercent:1,slippagePercent:1,buyTaxPercent:1,sellTaxPercent:1,fillMode:'current_bar_close'},
 positionConfig:{mode:'single_entry',maxEntries:1,maxConcurrentPositions:1,allowReentry:false,sizing:{type:'fixed_percent',value:90}}};
 const inputs=symbols.map(symbol=>({symbol,candles:Array.from({length:150},(_,i)=>{const close=10+Math.sin(i*.42)*3+Math.sin(i*.71),time=base+5*DAY+i*30000;return {time,closeTime:time+30000,open:close,high:close*1.05,low:close*.95,close,volume:100};})}));
 return {config,signals,inputs,partition:partitionDays(signals)};
}
test('combined cohort reruns shared cash, preserves fees and end closes, matches production replay',()=>{
 const {config,signals,inputs,partition}=fixture(),candidate={id:'test',config};
 const actual=evaluateCohort(candidate,inputs,signals,'30s',[1,2],partition),reference=runBacktest(config,inputs);
 assert(actual.totalTrades>0);assert.equal(actual.accountReturn,reference.report.returnPercent);assert.equal(actual.accountMaxDrawdown,reference.report.maxDrawdownPercent);
 assert.equal(actual.audit.fees,reference.trades.reduce((n,t)=>n+t.fees,0));assert.equal(actual.excludedCount,actual.totalTrades);
 const singles=[1,2].map(f=>evaluateCohort(candidate,inputs,signals,'30s',[f],partition));assert.notEqual(actual.netPnl,singles.reduce((n,r)=>n+r.netPnl,0));
 const repeat=evaluateCohort(candidate,[...inputs].reverse(),signals,'30s',[1,2],partition);assert.equal(actual.audit.tradeHash,repeat.audit.tradeHash);
});
test('no post-signal candles means no buys; signal equality is not a legal entry',()=>{
 const {config,signals,inputs}=fixture();const signalTime=inputs[0].candles.at(-1).time;
 const late=signals.map(s=>({...s,signalTime})),p=partitionDays(late);
 const r=evaluateCohort({id:'late',config},inputs,late,'30s',[1,2,3,4,5],p);assert.equal(r.totalTrades,0);assert.equal(r.audit.buyEvents,0);
});
test('server parity checks reject changed result and deterministic IDs are stable',()=>{
 const {config,signals,inputs,partition}=fixture(),actual=evaluateCohort({id:'t',config},inputs,signals,'30s',[1,2],partition),engine=new ResumableEngine(config);
 for(let i=0;i<inputs[0].candles.length;i++)engine.step(inputs.map(p=>({symbol:p.symbol,candle:p.candles[i],last:i===p.candles.length-1})));
 const batch=engine.drain(),ref={report:engine.finish(),trades:batch.trades,signals:batch.signals};
 compareResult(actual,ref.report,ref.trades,ref.signals);
 assert.throws(()=>compareResult(actual,{...ref.report,returnPercent:999},ref.trades,ref.signals));
 assert.equal(deterministicId({a:1}),deterministicId({a:1}));assert.notEqual(deterministicId({a:1}),deterministicId({a:2}));
});
test('read-only snapshot to local search, frozen protocol and no held-out access when development fails',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meme-cohort-'));
 try{
  const {config}=fixture(),report=join(dir,'import.jsonl');await writeFile(report,'{"kind":"start"}\n{"kind":"summary"}\n');
  const calls=[];let fetched=false;
  const client={connect:async()=>{},end:async()=>{},query:async(sql)=>{calls.push(sql);let rows=[];
   if(sql.includes('txid_current_snapshot'))rows=[{snapshot:'test'}];
   else if(sql.includes('FROM public.token_info'))rows=Array.from({length:5},(_,i)=>({chain:'sol',ca:String(i),pair:String(i),signal_time:base+i*DAY}));
   else if(sql.includes('FROM backtest_strategy_versions'))rows=[{name:'Meme Fib 黄金口袋回撤',strategy_json:config}];
   else if(sql.startsWith('DECLARE'))fetched=false;
   else if(sql.startsWith('FETCH')&&!fetched){fetched=true;rows=[{ca:'0',pair_id:'0',open_time:base+6*DAY,close_time:base+6*DAY+30000,open:1,high:1,low:1,close:1,volume:1,valid:true}];}
   return {rows,rowCount:rows.length};}};
  const manifest=await snapshot({output:join(dir,'snapshot'),importReport:report,client});
  assert.equal(manifest.files.length,12);assert(calls.includes('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'));assert(!calls.some(s=>/INSERT|UPDATE|DELETE/.test(s)));
  assert.equal(await fileHash(join(dir,'snapshot',manifest.files[0].name)),manifest.files[0].sha256);
  const opts={snapshot:join(dir,'snapshot'),output:join(dir,'study'),chain:'sol',count:4};
  const first=await research(opts),second=await research(opts);assert.deepEqual(first.shortlist,second.shortlist);assert.equal(first.candidates,8);assert.equal(first.uploadCandidates.length,0);
  const cache=JSON.parse(await readFile(join(dir,'study','evaluations.json'),'utf8'));assert(Object.keys(cache).every(k=>!/:4:|:5:/.test(k)));
  await assert.rejects(()=>research({...opts,seed:1}),/protocol differs/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
