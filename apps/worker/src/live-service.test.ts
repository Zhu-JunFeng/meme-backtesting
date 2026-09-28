import {describe,expect,it} from 'vitest';
import {acceptsNewSignal,backfillWindows,canMonitor,eligibleMarketCap,LIVE_CA_LIMIT} from './live-service.js';

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
