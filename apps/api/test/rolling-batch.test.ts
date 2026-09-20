import{describe,it,expect}from'vitest';
import{winningIds}from'../src/rolling-batch.js';
const row=(chain:string,n:number,value:number,drawdown=0)=>({chain,run_id:`${chain}-${n}`,ordinal:n,return_percent:value,max_drawdown_percent:drawdown,summary_json:{status:'completed'}});
describe('per-chain rolling leaderboard',()=>{
 it('retains ten for each chain, not ten globally',()=>{const a=Array.from({length:30},(_,n)=>row('sol',n,n-100)),b=Array.from({length:30},(_,n)=>row('robin',n,n));const ids=winningIds([...a,...b]);expect(ids.size).toBe(20);expect(ids.has('sol-29')).toBe(true);expect(ids.has('sol-19')).toBe(false);});
 it('uses exact scores, drawdown then ordinal; zero-trade zero return can beat losses',()=>{const a=[row('sol',0,-1),row('sol',1,0),row('sol',2,.001,2),row('sol',3,.001,1),row('sol',4,.001,1)];expect([...winningIds(a,2)]).toEqual(['sol-3','sol-4']);expect([...winningIds(a,4)]).not.toContain('sol-0');});
 it('excludes missing and nonfinite reports',()=>{expect(winningIds([{...row('sol',0,NaN)}, {...row('sol',1,1),summary_json:null},{...row('sol',2,3),max_drawdown_percent:Infinity}]).size).toBe(0);});
});
