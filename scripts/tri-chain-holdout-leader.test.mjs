import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rankShared} from './tri-chain-holdout-leader.mjs';
test('selects the same configuration across equal-capital chains, not one winner per chain',()=>{
 const row=(id,accountReturn,totalTrades=20,accountMaxDrawdown=5)=>({id,accountReturn,totalTrades,accountMaxDrawdown});
 const r=rankShared({sol:[row('a',10),row('b',5),row('small',100,1)],robin:[row('a',-20),row('b',4),row('small',100)],bsc:[row('a',30),row('b',3),row('small',100)]});
 assert.equal(r[0].id,'a');assert.equal(r.length,2);assert.equal(r[0].meanReturn,20/3);
 assert.throws(()=>rankShared({sol:[row('a',1)],robin:[],bsc:[]}));
});
