import {describe,expect,it} from 'vitest';
import {LiveCandleAggregator,LiveEvaluator,type MarketTrade} from '../src/live.js';
import type {Candle,StrategyConfig} from '@meme/domain';
import {matchBarExit} from '../src/bar-exit.js';

const t=(id:string,time:number,price:number,mcap=price*100):MarketTrade=>({id,chain:'sol',ca:'CA',pairId:'PAIR',time,price,mcap,volumeUsd:10});
describe('live candle aggregation',()=>{
 it('builds only real completed buckets and deduplicates trades',()=>{
  const bars:any[]=[];const a=new LiveCandleAggregator(bar=>bars.push(bar));
  expect(a.accept(t('a',31_000,2))).toBe(true);
  expect(a.accept(t('a',31_000,2))).toBe(false);
  a.accept(t('b',35_000,3));a.flush(59_999);expect(bars).toHaveLength(0);
  a.flush(60_000);expect(bars).toHaveLength(4);
  expect(bars.find(b=>b.type==='price').candle).toMatchObject({time:30_000,open:2,high:3,close:3,volume:20});
  a.accept(t('c',120_000,4));a.flush(150_000);
  expect(bars.filter(b=>b.interval==='30s'&&b.type==='price').map(b=>b.candle.time)).toEqual([30_000,120_000]);
 });
 it('never rewrites finalized bars, while correcting still-open buckets',()=>{
  const bars:any[]=[];const a=new LiveCandleAggregator(bar=>bars.push(bar));
  a.accept({...t('a',0,1),mcap:undefined});a.flush(30_000);
  expect(a.acceptDetailed({...t('b',10_000,9),mcap:undefined})).toMatchObject({accepted:true,reason:undefined}); // 1m remains open
  expect(a.accept({...t('c',35_000,3),mcap:undefined})).toBe(true);
  expect(a.acceptDetailed({...t('d',34_000,9),mcap:undefined})).toMatchObject({accepted:true,late:true});
  a.flush(60_000);
  expect(bars.filter(b=>b.type==='mcap')).toHaveLength(0);
  expect(bars.find(b=>b.type==='price').candle.close).toBe(1);
  expect(bars.find(b=>b.interval==='30s'&&b.candle.time===30_000).candle).toMatchObject({open:9,close:3,high:9,volume:20});
  expect(a.acceptDetailed({...t('e',34_500,7),mcap:undefined}).reason).toBe('closed');
 });
 it('drops old cross-bucket ticks at the 30-second boundary and sorts equal-time IDs',()=>{
  const bars:any[]=[];const a=new LiveCandleAggregator(bar=>bars.push(bar));
  a.accept(t('b',31_000,2));a.accept(t('a',31_000,1));a.accept(t('c',31_000,3));
  a.accept(t('later',61_000,4));
  expect(a.acceptDetailed(t('old',29_999,9))).toMatchObject({accepted:false,late:true,reason:'too_old'});
  a.flush(60_000);
  expect(bars.find(b=>b.interval==='30s'&&b.type==='price').candle).toMatchObject({open:1,close:3});
 });
 it('does not reopen already closed buckets after a reconnect or restart backfill',()=>{
  const bars:any[]=[];const a=new LiveCandleAggregator(bar=>bars.push(bar));
  a.accept(t('first',30_000,2));a.discardPair('sol','PAIR');
  a.markClosedThrough('sol','CA','PAIR',90_000);
  expect(a.acceptDetailed(t('late',59_999,8))).toMatchObject({accepted:false,reason:'closed'});
  expect(a.accept(t('fresh',90_000,3))).toBe(true);
  a.flush(120_000);
  expect(bars.filter(b=>b.interval==='30s'&&b.type==='price')).toHaveLength(1);
 });
 it('allows a >30s late tick only inside the same still-open 1m bucket',()=>{
  const bars:any[]=[];const a=new LiveCandleAggregator(bar=>bars.push(bar));
  a.accept(t('new',59_000,5));
  expect(a.acceptDetailed(t('old',1_000,2))).toMatchObject({accepted:true,late:true});
  a.flush(60_000);
  expect(bars.find(b=>b.interval==='1m'&&b.type==='price').candle).toMatchObject({open:2,close:5,volume:20});
  expect(bars.filter(b=>b.interval==='30s'&&b.type==='price')).toHaveLength(1);
 });
});

const config:StrategyConfig={schemaVersion:1,entryAfterSignal:true,impulseCondition:{type:'impulse_fractal_swing',leftBars:1,rightBars:1,lookbackBars:30,minGainPercent:50,maxDurationBars:20,requireVolumeExpansion:false},entryConditionGroup:{mode:'all',conditions:[{type:'fib_retracement',zoneLow:.5,zoneHigh:.9}]},invalidationConditionGroup:{mode:'any',conditions:[{type:'break_swing_low_invalidation'}]},exitConfig:{stopLoss:{type:'percent',value:10},takeProfit:{type:'percent',value:50},closeAtEnd:false,profitLock:{enabled:true,tiers:[{activationPercent:50,floorPercent:20}]}},positionConfig:{mode:'single_entry',maxEntries:1,maxConcurrentPositions:1,allowReentry:false,sizing:{type:'fixed_amount',value:10}},executionConfig:{initialCapital:100,feePercent:1,slippagePercent:1,buyTaxPercent:1,sellTaxPercent:1,fillMode:'current_bar_close'}};
const candle=(i:number,close:number):Candle=>({time:i*30_000,closeTime:(i+1)*30_000,open:close,high:close,low:close,close,volume:10});
describe('live evaluator',()=>{
 it('never enters on or before signal bar opening',()=>{
  const e=new LiveEvaluator(config,150_000);
  for(const [i,v] of [10,9,10,20,18,15].entries())expect(e.onClosedCandle(candle(i,v))).toBeUndefined();
  // A later bar may produce a signal, but historical bars cannot produce an authorized buy.
  expect(e.state.lastCandleTime).toBe(150_000);
 });
 it('closed bars retain the locked stop, even if the close recovered above it',()=>{
  const e=new LiveEvaluator(config,0);e.state.position={entryPrice:100,quantity:1,entries:1,entryTime:30_000,entryBar:1,impulse:{low:50,high:150,lowIndex:0,highIndex:1,confirmedAtIndex:2,gainPercent:200,averageVolume:10},tradeNo:1,lockPrice:120,lockTier:0};
  expect(e.onClosedCandle({...candle(2,130),open:130,low:119})).toMatchObject({reason:'profit_lock',value:120,time:90_000});
  expect(e.onClosedCandle(candle(2,110))).toBeUndefined();
 });
 it('confirms locks after fills, for the next bar, and preserves them across restore/adds',()=>{
  const cfg=structuredClone(config);cfg.exitConfig.takeProfit={type:'percent',value:500};
  const e=new LiveEvaluator(cfg,0);e.state.position={entryPrice:100,quantity:1,entries:1,entryTime:0,entryBar:0,impulse:{low:50,high:150,lowIndex:0,highIndex:1,confirmedAtIndex:2,gainPercent:200,averageVolume:10},tradeNo:1};
  const c={...candle(1,150),open:110,low:100};
  expect(e.onClosedCandle(c)).toBeUndefined();expect(e.state.position.lockPrice).toBeUndefined();
  e.confirmClose(c);expect(e.state.position.lockPrice).toBe(120);
  e.state.position.entryPrice=90;e.confirmClose(c);expect(e.state.position.lockPrice).toBe(120);
  const restored=new LiveEvaluator(cfg,0,e.snapshot());
  expect(restored.onClosedCandle({...candle(2,130),open:115,low:110})).toMatchObject({reason:'profit_lock',value:115});
 });
 it('does not generate missed orders or modify locks during recovery warmup',()=>{
  const e=new LiveEvaluator(config,0);e.state.position={entryPrice:100,quantity:1,entries:1,entryTime:0,entryBar:0,impulse:{low:50,high:150,lowIndex:0,highIndex:1,confirmedAtIndex:2,gainPercent:200,averageVolume:10},tradeNo:1};
  expect(e.onClosedCandle(candle(1,160),true)).toBeUndefined();expect(e.state.position.lockPrice).toBeUndefined();
  expect(e.onClosedCandle(candle(2,80),true)).toBeUndefined();expect(e.state.position).toBeDefined();
 });
 it('counts timeout from the entry bar without an off-by-one',()=>{
  const cfg=structuredClone(config);cfg.exitConfig.maxHoldingBars=2;
  const e=new LiveEvaluator(cfg,0);e.onClosedCandle(candle(0,100),true);
  e.state.position={entryPrice:100,quantity:1,entries:1,entryTime:30_000,entryBar:0,impulse:{low:50,high:150,lowIndex:0,highIndex:1,confirmedAtIndex:2,gainPercent:200,averageVolume:10},tradeNo:1};
  expect(e.onClosedCandle(candle(1,100))).toBeUndefined();
  expect(e.onClosedCandle(candle(2,100))).toMatchObject({reason:'timeout'});
 });
});

describe('shared completed-bar exit matching',()=>{
 const p={entry:100,baseStop:90,target:150,invalid:()=>false,timedOut:false};
 it.each([
  [{open:100,high:160,low:80,close:110},'stop_loss',90],
  [{open:85,high:160,low:80,close:110},'stop_loss',85],
  [{open:100,high:160,low:95,close:110},'take_profit',150],
  [{open:160,high:170,low:155,close:165},'take_profit',160],
 ] as const)('matches intrabar touches and gaps after close: %j',(ohlc,type,price)=>{
  expect(matchBarExit({...candle(1,ohlc.close),...ohlc},p)).toEqual({type,price});
 });
 it('keeps invalidation before targets, then timeout and end',()=>{
  const c={...candle(1,110),high:160,low:95};
  expect(matchBarExit(c,{...p,invalid:()=>true})).toEqual({type:'invalidation',price:110});
  expect(matchBarExit(candle(1,110),{...p,timedOut:true,end:true})?.type).toBe('timeout');
  expect(matchBarExit(candle(1,110),{...p,end:true})?.type).toBe('end_of_backtest');
 });
});

describe('connected idle buckets',()=>{
 it.each(['30s','1m'] as const)('fills %s only with explicit healthy connection permission',interval=>{
  const bars:any[]=[];const a=new LiveCandleAggregator(b=>bars.push(b));a.accept(t('a',1_000,2));a.flush(60_000,()=>true);
  a.flush(120_000,()=>true);
  const idle=bars.filter(b=>b.interval===interval&&b.type==='price'&&b.candle.synthetic);
  expect(idle.length).toBeGreaterThan(0);expect(idle.every(b=>b.candle.open===2&&b.candle.close===2&&b.candle.volume===0)).toBe(true);
  const n=bars.length;a.flush(180_000,()=>false);expect(bars.length).toBe(n);
  a.discardPair('sol','PAIR');a.flush(240_000,()=>true);expect(bars.length).toBe(n);
 });
 it('does not duplicate an idle bucket or overwrite a real candle',()=>{
  const bars:any[]=[];const a=new LiveCandleAggregator(b=>bars.push(b));a.accept(t('a',1000,2));a.flush(60_000,()=>true);
  a.accept(t('b',61_000,3));a.flush(90_000,()=>true);a.flush(90_000,()=>true);
  const selected=bars.filter(b=>b.type==='price'&&b.interval==='30s');
  expect(selected.map(b=>b.candle.time)).toEqual([0,30_000,60_000]);expect(selected.at(-1).candle.close).toBe(3);
 });
});
