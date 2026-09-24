import test from 'node:test';
import assert from 'node:assert/strict';
import {chronologicalPartition,candidateSet} from './expanded-signal-research.mjs';

test('two chronological CA-disjoint folds are fixed before returns are known',()=>{
 const signals=Array.from({length:10},(_,i)=>({chain:'sol',ca:`ca${i}`,signalTime:i+1}));
 const a=chronologicalPartition(signals),b=chronologicalPartition([...signals].reverse());
 assert.deepEqual(a,b);
 assert.deepEqual(a.counts,[6,4]);
 assert(a.entries.slice(0,6).every(e=>e.fold===1));
 assert(a.entries.slice(6).every(e=>e.fold===2));
 assert.equal(new Set(a.entries.map(e=>e.ca)).size,10);
});

test('candidate costs are raised to the fixed strict assumptions without mutating source',()=>{
 const config={entryAfterSignal:true,exitConfig:{closeAtEnd:true},executionConfig:{feePercent:.3,slippagePercent:.5,buyTaxPercent:0,sellTaxPercent:0,initialCapital:10000}};
 const protocol={candidates:[{id:'30s-test',interval:'30s',config},{id:'1m-test',interval:'1m',config}]};
 const result=candidateSet(protocol,1);
 assert.equal(result.length,2);
 for(const c of result)assert.deepEqual(Object.fromEntries(['feePercent','slippagePercent','buyTaxPercent','sellTaxPercent'].map(k=>[k,c.config.executionConfig[k]])),
  {feePercent:1,slippagePercent:1,buyTaxPercent:1,sellTaxPercent:1});
 assert.equal(config.executionConfig.feePercent,.3);
});
