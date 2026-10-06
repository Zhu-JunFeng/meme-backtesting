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
  const base=Math.floor(Date.now()/30_000)*30_000-8*30_000;
  const rows=Array.from({length:5},(_,index)=>({time:base+index*30_000,closeTime:base+(index+1)*30_000,open:1,high:1,low:1,close:1,volume:1}));
  const query=vi.fn(async(sql:string)=>({rows:sql.startsWith('SELECT')?rows:[]}));
  const service=new LiveService({query} as never);
  const evaluator=new LiveEvaluator(strategy,Number.MAX_SAFE_INTEGER);
  const ctx={run:{id:'run',interval:'30s',value_type:'mcap',strategy_json:strategy},watch:{chain:'robin',ca:'ca',pair_id:'pair',signal_time:String(Number.MAX_SAFE_INTEGER)},evaluator,noOrdersBefore:base-1_000};
  expect(await (service as any).warmupFromConnectedFeed(ctx)).toMatchObject({ready:true,count:5,required:5});
  expect(ctx.evaluator.state.history).toHaveLength(5);
  expect(ctx.evaluator.state.position).toBeUndefined();
  expect(query.mock.calls[0][0]).toContain("source='xxyy_socket'");
  ctx.evaluator.state.position={entryPrice:1} as never;
  expect(await (service as any).warmupFromConnectedFeed(ctx)).toMatchObject({ready:false});
 });
});
describe('monitor admission',()=>{
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
