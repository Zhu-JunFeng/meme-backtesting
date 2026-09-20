import {it,expect,vi,beforeEach} from 'vitest';
vi.mock('../src/fib.js',()=>({tradeFib:vi.fn(async()=>({status:'unavailable',reason:'test'}))}));
vi.mock('../src/results.js',async importOriginal=>({...await importOriginal<any>(),loadResults:vi.fn()}));
import {loadResults} from '../src/results.js';
import {locate} from '../src/locator.js';
const run={id:'run',config_json:{symbols:[{chain:'sol',ca:'ca',pairId:'pair'}],interval:'30s',valueType:'mcap',pools:[{chain:'sol',ca:'ca',pairId:'pair',startTime:0,endTime:9000000}]}};
const q={chain:'sol',ca:'ca',pairId:'pair'};
beforeEach(()=>{vi.mocked(loadResults).mockResolvedValue({trades:[{id:'trade',entry_time:600000,exit_time:900000}],signals:[{id:'s',trade_id:'trade',signal_type:'entry',time:600000,price:12}]});});
it.each([['30s','mcap'],['1m','price']])('locates first trade with locked %s/%s and real neighbours',async(interval,type)=>{
 const query=vi.fn().mockResolvedValue({rows:[{before:30000,after:3900000}]});
 const r=await locate({query} as any,{...run,config_json:{...run.config_json,interval,valueType:type}},q);
 expect(r.from).toBe(30000);expect(r.to).toBe(3900000);expect(r.events[0].price).toBe(12);expect(query.mock.calls[0][1]).toContain(interval);expect(query.mock.calls[0][1]).toContain(type);
});
it('does not fabricate entry or exit for an empty selection',async()=>{vi.mocked(loadResults).mockResolvedValue({trades:[],signals:[]});const query=vi.fn();expect((await locate({query} as any,run,q)).empty).toBe(true);expect(query).not.toHaveBeenCalled();});
it('rejects foreign pools and nonexistent event IDs',async()=>{await expect(locate({} as any,run,{...q,ca:'other'})).rejects.toThrow('不属于');await expect(locate({} as any,run,{...q,eventId:'missing'})).rejects.toThrow('不存在');});
it('queries immutable input when available',async()=>{const query=vi.fn().mockResolvedValue({rows:[{before:30000,after:900000}]});await locate({query} as any,{...run,input_ready:true},{...q,eventId:'s'});expect(query.mock.calls[0][0]).toContain('backtest_input_chunks');});
it('excluded selected trade falls back to first matching trade and filters all markers',async()=>{
 vi.mocked(loadResults).mockResolvedValue({trades:[{id:'end',entry_time:100,exit_time:200,excluded_end:true},{id:'profit',entry_time:600000,exit_time:900000,exit_reason:'take_profit'}],signals:[{id:'hidden',trade_id:'end',time:650000,signal_type:'entry'},{id:'shown',trade_id:'profit',time:600000,signal_type:'entry'}]});
 const query=vi.fn().mockResolvedValue({rows:[{before:30000,after:3900000}]});const r=await locate({query} as any,run,{...q,tradeId:'end',includeEndOfBacktest:'false',signalTypes:'take_profit'});
 expect(r.tradeId).toBe('profit');expect(r.events.map((s:any)=>s.id)).toEqual(['shown']);
});
