import {it,expect,vi} from 'vitest';
vi.mock('../src/fib.js',()=>({tradeFib:vi.fn(async()=>({status:'unavailable',reason:'test'}))}));
import {locate} from '../src/locator.js';
const run={id:'run',config_json:{symbols:[{chain:'sol',ca:'ca',pairId:'pair'}],interval:'30s',valueType:'mcap',pools:[{chain:'sol',ca:'ca',pairId:'pair',startTime:0,endTime:9000000}]}};
it.each([['30s','mcap'],['1m','price']])('locates first trade with locked %s/%s and real candle neighbours',async(interval,type)=>{
 const query=vi.fn().mockResolvedValueOnce({rows:[{id:'trade',entry_time:600000,exit_time:900000}]}).mockResolvedValueOnce({rows:[{before:30000,after:3900000}]}).mockResolvedValueOnce({rows:[{signal_type:'entry',time:600000,price:12}]});
 const r=await locate({query} as any,{...run,config_json:{...run.config_json,interval,valueType:type}},{chain:'sol',ca:'ca',pairId:'pair'});
 expect(r.from).toBe(30000);expect(r.to).toBe(3900000);expect(r.events[0].price).toBe(12);expect(query.mock.calls[0][0]).toContain('ORDER BY entry_time,id LIMIT 1');expect(query.mock.calls[1][1]).toContain(interval);expect(query.mock.calls[1][1]).toContain(type);
});
it('does not fabricate entry or exit for a pool without trades',async()=>{const query=vi.fn().mockResolvedValue({rows:[]});expect((await locate({query} as any,run,{chain:'sol',ca:'ca',pairId:'pair'})).empty).toBe(true);expect(query).toHaveBeenCalledTimes(1);});
it('rejects cross-run or foreign pool requests',async()=>{await expect(locate({} as any,run,{chain:'sol',ca:'other',pairId:'pair'})).rejects.toThrow('不属于');});
it('queries immutable frozen input when available',async()=>{const query=vi.fn().mockResolvedValueOnce({rows:[{time:600000}]}).mockResolvedValueOnce({rows:[{before:30000,after:900000}]}).mockResolvedValueOnce({rows:[]});await locate({query} as any,{...run,input_ready:true},{chain:'sol',ca:'ca',pairId:'pair',eventId:'1'});expect(query.mock.calls[1][0]).toContain('backtest_input_chunks');});
