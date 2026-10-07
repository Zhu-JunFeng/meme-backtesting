import {describe,expect,it,vi} from 'vitest';
import {LiveEvaluator} from '@meme/engine';
import {acceptsNewSignal,backfillWindows,canMonitor,eligibleMarketCap,localWarmupBars,LiveService,LIVE_CA_LIMIT} from './live-service.js';
import type {StrategyConfig} from '@meme/domain';

describe('source-isolated paper runs',()=>{
 const signal={chain:'robin' as const,ca:'0x123',source:'top_cluster_first_buy' as const,time:2000,key:'signal-1',identity:{}};
 it('does not admit another source into the run',()=>{
  expect(acceptsNewSignal({signal_source:'fomo_new_project_expanded',started_at:new Date(1000)},signal)).toBe(false);
  expect(acceptsNewSignal({signal_source:'top_cluster_first_buy',started_at:new Date(1000)},signal)).toBe(true);
 });
 it('requires signal time strictly after task start',()=>{
  expect(acceptsNewSignal({signal_source:'top_cluster_first_buy',started_at:new Date(2000)},signal)).toBe(false);
  expect(acceptsNewSignal({signal_source:'top_cluster_first_buy',started_at:new Date(3000)},signal)).toBe(false);
 });
});
describe('recovery windows',()=>{
 it('keeps every fetch at or below five thousand candles with no overlap',()=>{
  expect([...backfillWindows(0,12_001*30_000,30_000)]).toEqual([
   {from:0,to:5000*30_000},{from:5000*30_000,to:10_000*30_000},{from:10_000*30_000,to:12_001*30_000},
  ]);
  expect([...backfillWindows(0,0,60_000)]).toEqual([]);
 });
 it('rejects an unaligned recovery range',()=>{
  expect(()=>[...backfillWindows(1,60_000,60_000)]).toThrow();
 });
 it('requires enough connected-feed bars for the impulse and every nested indicator',()=>{
  const strategy={
   impulseCondition:{lookbackBars:200,leftBars:2,rightBars:2},
   entryConditionGroup:{mode:'all',conditions:[{type:'fib_retracement'},{mode:'any',conditions:[{type:'rsi_recovery',period:14}]}]},
   invalidationConditionGroup:{mode:'any',conditions:[{type:'bearish_volume_invalidation',period:10}]},
  } as unknown as StrategyConfig;
  expect(localWarmupBars(strategy)).toBe(205);
  strategy.impulseCondition.lookbackBars=10;
  expect(localWarmupBars(strategy)).toBe(16);
 });
 it('rebuilds a flat evaluator only from the current connected-feed epoch',async()=>{
  const strategy={
   impulseCondition:{lookbackBars:2,leftBars:1,rightBars:1},
   entryConditionGroup:{mode:'all',conditions:[]},
   invalidationConditionGroup:{mode:'any',conditions:[]},
  } as unknown as StrategyConfig;
  const base=Math.floor(Date.now()/30_000)*30_000-5*30_000;
  const rows=Array.from({length:5},(_,index)=>({time:base+index*30_000,closeTime:base+(index+1)*30_000,open:1,high:1,low:1,close:1,volume:1}));
  const query=vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT')?rows:[]}));
  const service=new LiveService({query} as never);
  const evaluator=new LiveEvaluator(strategy,Number.MAX_SAFE_INTEGER);
  const ctx={run:{id:'run',interval:'30s',value_type:'mcap',strategy_json:strategy},watch:{chain:'robin',ca:'ca',pair_id:'pair',signal_time:String(Number.MAX_SAFE_INTEGER)},evaluator,noOrdersBefore:base-1_000};
  expect(await (service as any).warmupFromConnectedFeed(ctx)).toMatchObject({ready:true,count:5,required:5});
  expect(ctx.evaluator.state.history).toHaveLength(5);
  expect(ctx.evaluator.state.position).toBeUndefined();
  expect(query.mock.calls[0][0]).toContain("source='meme_market_v2'");
  ctx.evaluator.state.position={entryPrice:1} as never;
  expect(await (service as any).warmupFromConnectedFeed(ctx)).toMatchObject({ready:false});
 });
});
describe('monitor admission',()=>{
 it('keeps slow HTTP work outside the event queue and fences its result after a disconnect',async()=>{
  const service:any=new LiveService({query:vi.fn(async()=>({rows:[]}))} as never);
  const ctx={run:{id:'r',status:'running',interval:'1m',value_type:'price'},watch:{chain:'sol',ca:'a',pair_id:'p',last_candle_time:null},noOrdersBefore:0};
  service.watches.set('r:sol:a',ctx);service.marketSessions.set('sol:a','s');service.marketEpochs.set('sol:a',1);
  let resolve!:(value:any)=>void;service.history={get:vi.fn(()=>new Promise(r=>resolve=r))};service.applyHistory=vi.fn();service.finishRecovery=vi.fn();
  service.launchRecovery(ctx);const tick=vi.fn(async()=>{});service.enqueue(tick);await service.chain;expect(tick).toHaveBeenCalledOnce();expect(service.applyHistory).not.toHaveBeenCalled();
  service.marketEpochs.set('sol:a',2);resolve({rows:[]});await vi.waitFor(()=>expect(service.recovering.size).toBe(0));expect(service.applyHistory).not.toHaveBeenCalled();expect(service.finishRecovery).not.toHaveBeenCalled();
 });
 it('does not reseed the shared aggregator when a second task recovers the same pool',async()=>{
  const query=vi.fn();const service:any=new LiveService({query} as never);service.aggregator.seed=vi.fn();
  const ctx={run:{interval:'1m'},watch:{chain:'sol',pair_id:'p'}};service.watches.set('other',{...ctx,ready:true});
  await service.seedAggregation(ctx);expect(query).not.toHaveBeenCalled();expect(service.aggregator.seed).not.toHaveBeenCalled();
 });
 function waitingService(){
  const service:any=new LiveService({query:vi.fn(async()=>({rows:[]}))} as never);
  service.watches.set('r:robin:a',{run:{id:'r',status:'running',value_type:'mcap'},watch:{chain:'robin',ca:'a',pair_id:'p'},ready:true});
  service.marketSessions.set('robin:a','s');service.marketEpochs.set('robin:a',0);
  let info:any,release!:()=>void;const promise=new Promise<any>(resolve=>{release=()=>{info={supply:{tokens:'1000000000'}};resolve(info);};});
  service.projects={peek:()=>info,status:()=>undefined,get:vi.fn(()=>promise)};
  service.onTrade=vi.fn(async()=>{});
  const raw={chain:'robin',ca:'a',pair_id:'p',event_id:'1',trade_time:60000,price_usd:'0.001',volume_usd:'10',market_cap_usd:null};
  return {service,raw,release};
 }
 it('buffers the entire project stream while supply is pending, including WS-valued trades',async()=>{
  const {service,raw,release}=waitingService();service.receiveTrade(raw,'s');service.receiveTrade({...raw,event_id:'2',trade_time:65000,market_cap_usd:'2000000'},'s');
  await service.chain;expect(service.onTrade).not.toHaveBeenCalled();expect(service.projectTrades.get('robin:a')).toHaveLength(2);expect(service.projects.get).toHaveBeenCalledTimes(1);
  release();await vi.waitFor(()=>expect(service.onTrade).toHaveBeenCalledTimes(2));
  expect(service.onTrade.mock.calls.map((x:any)=>x[0].mcap)).toEqual([1000000,2000000]);
 });
 it('rejects old buffered trades after disconnect even when lookup later succeeds',async()=>{
  const {service,raw,release}=waitingService();service.receiveTrade(raw,'s');service.interruptMarket([{chain:'robin',ca:'a'}],'disconnect');release();
  await vi.waitFor(()=>expect(service.projectLoading.size).toBe(0));await service.chain;expect(service.onTrade).not.toHaveBeenCalled();
 });
 it('bounds the per-project buffer and invalidates an overflowing bucket',async()=>{
  const {service,raw}=waitingService();service.market.resetProjects=vi.fn();
  for(let i=0;i<257;i++)service.receiveTrade({...raw,event_id:String(i)},'s');
  expect(service.quality.overflow).toBe(1);expect(service.projectTrades.has('robin:a')).toBe(false);expect(service.market.resetProjects).toHaveBeenCalledOnce();await service.chain;
 });
 it('ignores unrelated pools without aggregation or metadata lookup',async()=>{
  const {service,raw}=waitingService();service.receiveTrade({...raw,pair_id:'other'},'s');await service.chain;expect(service.projects.get).not.toHaveBeenCalled();expect(service.onTrade).not.toHaveBeenCalled();
 });
 it('fences ready contexts and removes queued bars immediately on interruption',async()=>{
  const query=vi.fn(async()=>({rows:[]}));const service:any=new LiveService({query} as never);
  const ctx={run:{id:'r'},watch:{chain:'robin',ca:'a',pair_id:'p'},ready:true};
  service.watches.set('r:robin:a',ctx);service.marketSessions.set('robin:a','session');service.connected.add('robin:p');service.confirmedFeeds.add('robin:p');
  service.closedBars.push({symbol:{chain:'robin',ca:'a',pairId:'p'}});
  service.interruptMarket([{chain:'robin',ca:'a'}],'gap');
  expect(ctx.ready).toBe(false);expect(service.connected.size).toBe(0);expect(service.marketSessions.size).toBe(0);expect(service.closedBars).toEqual([]);
  await service.chain;
 });
 it('allows exactly twenty active CAs per run and keeps existing watches',()=>{
  expect(canMonitor(LIVE_CA_LIMIT-1,false)).toBe(true);
  expect(canMonitor(LIVE_CA_LIMIT,false)).toBe(false);
  expect(canMonitor(LIVE_CA_LIMIT,true)).toBe(true);
 });
 it('requires a trustworthy market cap at or above 50,000 USD',()=>{
  expect(eligibleMarketCap(49_999.99)).toBe(false);
  expect(eligibleMarketCap(50_000)).toBe(true);
  expect(eligibleMarketCap('50000')).toBe(true);
  expect(eligibleMarketCap(null)).toBe(false);
  expect(eligibleMarketCap(undefined)).toBe(false);
  expect(eligibleMarketCap('not-a-number')).toBe(false);
 });
});
