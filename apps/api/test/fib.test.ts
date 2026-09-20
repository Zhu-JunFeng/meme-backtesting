import {it,expect,vi} from 'vitest';
import {FibIndexMapper,fibLevels,tradeFib} from '../src/fib.js';
it.each([30000,60000])('maps real and synthetic indices at %s without expanding a long gap',step=>{
 const m=new FibIndexMapper([0,1,2,100000],step);m.accept({time:123,close:10,low:8,high:12});m.accept({time:123+100000*step,close:20,low:18,high:22});
 expect(m.points.get(1)).toEqual({time:123+step,low:10,high:10,synthetic:true});expect(m.points.get(100000).low).toBe(18);expect(m.index).toBe(100000);
});
it('preserves irregular real timestamps and detects out-of-order input',()=>{const m=new FibIndexMapper([1,2],30);m.accept({time:0,close:10});m.accept({time:45,close:20});expect(m.points.get(1).time).toBe(30);expect(m.points.get(2).time).toBe(45);expect(()=>m.accept({time:44})).toThrow();});
const config={entryConditionGroup:{mode:'any',conditions:[{type:'fib_retracement',zoneLow:.61,zoneHigh:.79},{enabled:false,type:'fib_retracement',zoneLow:.1,zoneHigh:.2}]},invalidationConditionGroup:{mode:'all',conditions:[{type:'break_fib_invalidation',ratio:.886,bufferPercent:2}]},exitConfig:{stopLoss:{type:'fib_level',ratio:.9,bufferPercent:10},takeProfit:{type:'previous_high'}}};
it('uses high=0 low=1 and records nested strategy relationships and buffered thresholds',()=>{const f=fibLevels(config,{low:100,high:200});expect(f.levels.find(l=>l.ratio===0)?.value).toBe(200);expect(f.levels.find(l=>l.ratio===1)?.value).toBe(100);expect(f.levels.find(l=>l.ratio===.61)?.value).toBe(139);expect(f.levels.some(l=>l.ratio===.1)).toBe(false);expect(f.zones[0].label).toContain('any');expect(f.thresholds.at(-1)?.value).toBe(99);});
const imp={low:10,high:20,lowIndex:0,highIndex:1,confirmedAtIndex:2};
function db(i:any,version='portfolio-4'){
 const trade={id:'t',chain:'sol',ca:'a',pair_id:'p',entry_time:90000,exit_time:120000,entry_price:13,quantity:1,trade_no:1,adds_json:[]};
 const signal={id:'s',chain:'sol',ca:'a',pair_id:'p',signal_type:'entry',time:90000,price:13,quantity:1,trade_no:1,reason_json:{impulse:i}};
 return {query:vi.fn(async(sql:string)=>({rows:sql.includes('SELECT * FROM backtest_trades')?[trade]:sql.includes('SELECT * FROM backtest_signals')?[signal]:sql.includes('SELECT config_json')?[{config_json:config}]:sql.includes('UNION ALL')?[{version}]:sql.includes('SELECT chunk_no')?[{chunk_no:0,candles_json:[{time:0,low:10,high:12,close:11},{time:30000,low:18,high:20,close:19},{time:60000,low:13,high:14,close:13}]}]:[]}))};
}
const run={id:'r',input_ready:true,config_json:{...config,interval:'30s'}},q={chain:'sol',ca:'a',pairId:'p'};
it('restores legacy anchors only from immutable input and maps sell-event association',async()=>{const p=db(imp);const f=await tradeFib(p as any,run,q,'t');expect(f.status).toBe('available');expect(f.high.time).toBe(30000);expect(f.buys[0].ratio).toBe(.7);expect(p.query.mock.calls.some(([s])=>s.includes('meme_kline'))).toBe(false);});
it('uses new snapshots without input queries',async()=>{const p=db({...imp,lowTime:0,highTime:30000,confirmedTime:60000});const f=await tradeFib(p as any,run,q,undefined,'s');expect(f.status).toBe('available');expect(p.query.mock.calls).toHaveLength(3);});
it('sell and add events resolve the original entry rather than selecting a new impulse',async()=>{
 for(const type of ['take_profit','add']){const p=db({...imp,lowTime:0,highTime:30000,confirmedTime:60000});const original=p.query;const query=async(sql:string)=>{const r=await original(sql);if(sql.includes('SELECT * FROM backtest_signals'))r.rows.push({...r.rows[0],id:'other',signal_type:type,time:120000,price:18,reason_json:{}});return r;};
  const f=await tradeFib({query} as any,run,q,undefined,'other');expect(f.status).toBe('available');expect(f.impulse.high).toBe(20);expect(f.entryTime).toBe(90000);
 }
});
it('ambiguous original entry is unavailable instead of guessed',async()=>{const p=db(imp);const original=p.query;const query=async(sql:string)=>{const r=await original(sql);if(sql.includes('SELECT * FROM backtest_signals'))r.rows.push({...r.rows[0],id:'duplicate'});return r;};const f=await tradeFib({query} as any,run,q,'t');expect(f.status).toBe('unavailable');});
it.each(['unknown','missing','mismatch','future'])('does not invent anchors on %s',async kind=>{const i={...imp,...(kind==='mismatch'?{high:21}:{}),...(kind==='future'?{lowTime:0,highTime:30000,confirmedTime:100000}:{})};const f=await tradeFib(db(i,kind==='unknown'?'portfolio-1':'portfolio-4') as any,{...run,input_ready:kind!=='missing'},q,'t');expect(f.status).toBe('unavailable');expect(f.levels.length).toBeGreaterThan(0);});
