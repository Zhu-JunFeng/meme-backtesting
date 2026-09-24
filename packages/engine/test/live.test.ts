import {describe,expect,it} from 'vitest';
import {LiveCandleAggregator,LiveEvaluator,type MarketTrade} from '../src/live.js';
import type {Candle,StrategyConfig} from '@meme/domain';

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
 it('rejects late trades and cannot invent market cap',()=>{
  const bars:any[]=[];const a=new LiveCandleAggregator(bar=>bars.push(bar));
  a.accept({...t('a',0,1),mcap:undefined});a.flush(30_000);
  expect(a.accept({...t('b',10_000,9),mcap:undefined})).toBe(false);
  expect(a.accept({...t('c',35_000,3),mcap:undefined})).toBe(true);
  expect(a.accept({...t('d',34_000,9),mcap:undefined})).toBe(false);
  a.flush(60_000);
  expect(bars.filter(b=>b.type==='mcap')).toHaveLength(0);
  expect(bars.find(b=>b.type==='price').candle.close).toBe(1);
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
 it('tick exits use actual subsequent trade value and retain locked stop',()=>{
  const e=new LiveEvaluator(config,0);e.state.position={entryPrice:100,quantity:1,entries:1,entryTime:30_000,entryBar:1,impulse:{low:50,high:150,lowIndex:0,highIndex:1,confirmedAtIndex:2,gainPercent:200,averageVolume:10},tradeNo:1,lockPrice:120,lockTier:0};
  expect(e.onTrade(t('x',30_000,110), 'price')).toBeUndefined();
  expect(e.onTrade(t('y',31_000,119), 'price')?.reason).toBe('profit_lock');
 });
});
