import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Worker} from 'node:worker_threads';
import {normalizeStrategy,firstRound,secondRound,ranking,attribution,evaluate,research,reportMarkdown} from './sol-full-history-research.mjs';
import {baseStrategy,COSTS} from './temporal-holdout-research.mjs';
import {snapshot,saveJson} from './cohort-snapshot.mjs';
import {canonical,evaluateWindow} from './offline-strategy-research.mjs';
import {runBacktest} from '../packages/engine/dist/index.js';

function fixture(){
 const c=normalizeStrategy(baseStrategy());Object.assign(c.impulseCondition,{lookbackBars:60,minGainPercent:10,maxDurationBars:50});
 c.entryConditionGroup={mode:'all',conditions:[{type:'fib_retracement',zoneLow:.1,zoneHigh:.9}]};
 c.invalidationConditionGroup={mode:'any',enabled:false,conditions:[]};c.exitConfig={stopLoss:{type:'percent',value:99},takeProfit:{type:'percent',value:10000},closeAtEnd:true};
 const inputs=['A','B'].map(ca=>({symbol:{chain:'sol',ca,pairId:ca},candles:Array.from({length:150},(_,i)=>{const close=10+Math.sin(i*.42)*3+Math.sin(i*.71),time=1800000000000+i*30000;return{time,closeTime:time+30000,open:close,high:close*1.05,low:close*.95,close,volume:100,valid:true};})}));
 return{c,inputs,asOf:inputs[0].candles.at(-1).closeTime};
}
test('normalization fixes costs, signal gate and v2 without mutating input',()=>{
 const c=baseStrategy(),original=structuredClone(c),n=normalizeStrategy(c);assert.deepEqual(c,original);
 assert.equal(n.entryAfterSignal,false);assert.equal(n.impulseCondition.selectionVersion,'pullback-v2');assert.deepEqual(n.executionConfig,COSTS);
 assert.equal(n.exitConfig.closeAtEnd,true);assert.equal(n.positionConfig.maxEntries,1);assert.equal(n.addConditionGroup.enabled,false);
 assert.throws(()=>normalizeStrategy({...c,positionConfig:{...c.positionConfig,sizing:{type:'fixed_percent',value:90}}}));
});
test('later workers reject a changed code fingerprint before loading any market data',async()=>{
 const worker=new Worker(new URL('./sol-full-history-research.mjs',import.meta.url),{workerData:{codeHash:'different-code'}});
 try{await assert.rejects(new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}),/Research code changed/);}finally{await worker.terminate();}
});
test('1024 deterministic unique first-round candidates and bounded unique refinements',()=>{
 const bases=[{name:'base',config:baseStrategy()}],a=firstRound(bases),b=firstRound(bases);assert.deepEqual(a,b);assert.equal(a.length,1024);
 const key=c=>JSON.stringify(canonical({interval:c.interval,config:c.config}));assert.equal(new Set(a.map(key)).size,1024);
 assert.equal(a.filter(c=>c.interval==='30s').length,512);
 assert.deepEqual(new Set(a.map(c=>c.config.positionConfig.sizing.value)),new Set([1,2,3,5,7.5,10]));
 for(const c of a){assert.equal(c.config.entryAfterSignal,false);assert.equal(c.config.impulseCondition.selectionVersion,'pullback-v2');assert.deepEqual(c.config.executionConfig,COSTS);}
 const rows=a.slice(0,5).map((c,i)=>({id:c.id,totalTrades:20,accountReturn:5-i,accountMaxDrawdown:1})),r=secondRound(a,rows);
 assert(r.length<=1000&&r.length>0);assert.equal(new Set([...a,...r].map(key)).size,a.length+r.length);assert.deepEqual(r,secondRound(a,rows));
});
test('ranking includes terminal pnl, excludes zero trades and has deterministic ties',()=>{
 const rows=[{id:'a',totalTrades:10,accountReturn:1,accountMaxDrawdown:2},{id:'b',totalTrades:11,accountReturn:1,accountMaxDrawdown:2},{id:'z',totalTrades:0,accountReturn:100,accountMaxDrawdown:0}];
 assert.deepEqual(ranking(rows).map(r=>r.id),['b','a']);
});
test('Chinese report converts fractional win rates and renders full rule text',()=>{
 const r={id:'test',interval:'30s',accountReturn:2,netPnl:200,accountMaxDrawdown:1,accountWinRate:.5,totalTrades:20,profitFactor:2,costs:{total:10},description:{generatedText:'完整规则'},attribution:Object.fromEntries(['beforeOrAtSignal','afterSignal','missingSignal'].map(k=>[k,{trades:0,netPnl:0}]))};
 const md=reportMarkdown({asOf:1700000000000,coverage:{},leaders:[r]});assert(md.includes('| 50.00% |'));assert(md.includes('完整规则'));assert(!md.includes('[object Object]'));
});
test('no signal is eligible; signal before/after/unknown attribution never conflates them',()=>{
 const symbol=ca=>({chain:'sol',ca,pairId:ca}),trades=[{symbol:symbol('A'),entryTime:100,netPnl:2},{symbol:symbol('A'),entryTime:101,netPnl:3},{symbol:symbol('B'),entryTime:100,netPnl:-1}];
 assert.deepEqual(attribution(trades,[{chain:'sol',ca:'A',signalTime:100}]),{beforeOrAtSignal:{trades:1,netPnl:2},afterSignal:{trades:1,netPnl:3},missingSignal:{trades:1,netPnl:-1}});
});
test('streaming summary equals reference replay, includes last closes and signal-free buys',()=>{
 const {c,inputs,asOf}=fixture(),candidate={id:'t',interval:'30s',config:c},batches=[];
 const r=evaluate(candidate,inputs,[],asOf,b=>batches.push(b));assert(r.totalTrades>0);assert.equal(r.attribution.missingSignal.trades,r.totalTrades);
 const ref=runBacktest({...c,name:'t',symbols:inputs.map(p=>p.symbol),interval:'30s',valueType:'mcap'},inputs);
 assert.equal(r.netPnl,ref.report.netPnl);assert.equal(r.accountMaxDrawdown,ref.report.maxDrawdownPercent);assert.equal(r.excludedCount,r.totalTrades);
 assert.equal(r.costs.total,ref.trades.reduce((n,t)=>n+t.fees+t.slippageCost+t.taxCost,0));
 assert.equal(batches.flatMap(b=>b.trades).length,r.totalTrades);assert.equal(r.tradeHash,evaluate(candidate,[...inputs].reverse(),[],asOf).tradeHash);
 const d=evaluateWindow(candidate,inputs,inputs[0].candles[0].time,asOf,{interval:'30s',warmupBars:0,detail:true});assert.equal(d.netPnl,r.netPnl);
});
test('SOL closed-only snapshot and batch resume equal uninterrupted run, protocol changes rejected',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sol-full-history-'));const {c,inputs}=fixture(),calls=[];let fetched=false,step=30000;
 const names=['Meme Fib 黄金口袋回撤','数据库信号后买入 · SOL · 探索 E0056 训练期亏损 · 20260922','三链测试集综合第一 · 30s-E0129 · Trending 模拟观察（验证亏损）'];
 const client={connect:async()=>{},end:async()=>{},query:async(sql,args)=>{calls.push({sql,args});let rows=[];
  if(sql.includes('txid_current_snapshot'))rows=[{snapshot:'test'}];
  else if(sql.includes('FROM backtest_strategy_versions'))rows=names.map(name=>({name,strategy_json:c}));
  else if(sql.includes('SELECT DISTINCT chain,interval,type'))rows=['30s','1m'].map(interval=>({chain:'sol',interval,type:'mcap'}));
  else if(sql.startsWith('DECLARE')){fetched=false;step=args[1]==='30s'?30000:60000;}
  else if(sql.startsWith('FETCH')&&!fetched){fetched=true;rows=inputs.flatMap(p=>p.candles.map((k,i)=>({ca:p.symbol.ca,pair_id:p.symbol.pairId,open_time:1700000040000+i*step,close_time:1700000040000+(i+1)*step,open:k.open,high:k.high,low:k.low,close:k.close,volume:100,valid:true})));}
  return{rows,rowCount:rows.length};}};
 try{
  const frozen=join(dir,'frozen');await snapshot({output:frozen,client,allKlines:true,researchMcapOnly:true,selectedChains:['sol'],closedOnly:true});
  assert(calls.filter(c=>c.sql.startsWith('DECLARE')).every(c=>c.sql.includes('close_time <= $4')&&c.args[0]==='sol'&&Number.isFinite(c.args[3])));
  assert(!calls.some(c=>/INSERT|UPDATE|DELETE/.test(c.sql)));const priorPath=join(dir,'prior.json');await saveJson(priorPath,{id:'30s-E0103',config:c});
  const opts={snapshot:frozen,output:join(dir,'resumed'),priorPath,count:4,refine:0};assert.equal((await research({...opts,maxRuns:3})).complete,false);
  const resumed=await research(opts),once=await research({...opts,output:join(dir,'once'),workers:1});assert.equal(resumed.candidates,8);
  const project=r=>r.leaders.map(x=>({id:x.id,netPnl:x.netPnl,tradeHash:x.tradeHash,signalHash:x.signalHash}));assert.deepEqual(project(resumed),project(once));
  assert.equal(JSON.parse(await readFile(join(opts.output,'progress.json'),'utf8')).rows.length,8);
  await assert.rejects(()=>research({...opts,seed:1}),/protocol changed/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
