import {describe,it,expect} from 'vitest';
import {invalidationHistory,restoreInvalidation,hydrateInvalidations} from '../src/invalidation.js';
import {filteredStatistics,selectResults,signalTypes} from '../src/results.js';
const b=(time:number,close:number,volume=10,open=close)=>({time,closeTime:time+30000,open,close,low:Math.min(open,close),high:Math.max(open,close),volume,valid:true});
const config={interval:'30s',invalidationConditionGroup:{mode:'any',conditions:[{type:'break_fib_invalidation',ratio:.886},{type:'break_swing_low_invalidation',bufferPercent:0},{type:'bearish_volume_invalidation',period:10,minRatio:2,minBodyPercent:20}]}};
const entry={time:0,reason_json:{impulse:{low:100,high:300,confirmedTime:0}}};
describe('query-only historical invalidation',()=>{
 it('restores only the bounded suffix, includes zero-volume gaps but not bars after raw end',()=>{
  const rows=[b(0,150),b(3000000,200)];
  expect(invalidationHistory(rows,120000,2,30000).map(c=>[c.time,c.volume])).toEqual([[60000,0],[90000,0],[120000,0]]);
  expect(invalidationHistory([b(0,150)],120000,2,30000)).toEqual([]);
 });
 it('restores multiple matches with fixed first-match classification and exact amounts',()=>{
  const d=restoreInvalidation(config,entry,{time:30000,price:90},[b(0,100),b(30000,90)]);
  expect(d.source).toBe('frozen_input');expect(d.matches.map(m=>m.code)).toEqual(['break_fib_invalidation','break_swing_low_invalidation']);
 });
 it('restores profitable bearish exits and rejects mismatched close, unsupported or unavailable evidence',()=>{
  const raw=[b(0,100),b(30000,160,20,200)];
  expect(restoreInvalidation(config,entry,{time:30000,price:160},raw).primary).toBe('bearish_volume_invalidation');
  expect(restoreInvalidation(config,entry,{time:30000,price:159},raw).primary).toBe('unknown');
  expect(restoreInvalidation(config,null,{time:30000,price:160},raw).primary).toBe('unknown');
  expect(restoreInvalidation({...config,invalidationConditionGroup:{mode:'any',conditions:[{type:'ema_reclaim',period:9}]}},entry,{time:30000,price:160},raw).primary).toBe('unknown');
 });
 it('detail filters use the primary cause, keep whole trades, dedupe parent/child union and preserve statistics',()=>{
  const trades=[{id:'a',entry_time:1,exit_time:2,exit_price:90,exit_reason:'invalidation',net_pnl:10,invalidation_detail:{primary:'break_fib_invalidation'}},{id:'b',entry_time:1,exit_time:2,exit_price:110,exit_reason:'invalidation',net_pnl:-5},{id:'end',entry_time:1,exit_time:2,exit_price:1,exit_reason:'end_of_backtest',net_pnl:-100}];
  const signals=[{trade_id:'a',signal_type:'entry'},{trade_id:'a',signal_type:'invalidation'},{trade_id:'b',signal_type:'entry'},{trade_id:'b',signal_type:'invalidation'}];
  const q={includeEndOfBacktest:'false',signalTypes:'invalidation:break_fib_invalidation'};
  expect(selectResults({trades,signals},q).signals).toHaveLength(2);
  expect(selectResults({trades,signals},{...q,signalTypes:q.signalTypes+',invalidation'}).trades).toHaveLength(2);
  expect(selectResults({trades,signals},{...q,signalTypes:'invalidation:unknown'}).trades[0].id).toBe('b');
  expect(signalTypes({signalTypes:q.signalTypes})).toEqual([q.signalTypes]);expect(()=>signalTypes({signalTypes:'invalidation:fake'})).toThrow();
  const stats=filteredStatistics(trades,signals,100,0,false);expect(stats.summary.netPnl).toBe(5);expect(stats.invalidationReasons.map(r=>r.count)).toEqual([1,1]);expect(stats.invalidationReasons.reduce((n,r)=>n+r.netPnl,0)).toBe(5);
 });
 it('uses saved evidence without database access and leaves original reason JSON intact',async()=>{
  const saved=restoreInvalidation(config,entry,{time:30000,price:90},[b(0,100),b(30000,90)]);saved.source='signal_snapshot';
  const reason={invalidation:saved};const data={trades:[{id:'t',exit_reason:'invalidation'}],signals:[{trade_id:'t',signal_type:'invalidation',reason_json:reason}]};
  const r=await hydrateInvalidations({query:()=>{throw Error('unexpected database read');}} as any,{id:'new',config_json:config},data);
  expect(r.trades[0].invalidation_detail).toEqual(saved);expect(r.signals[0].reason_json).toBe(reason);
 });
});
