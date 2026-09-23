import test from 'node:test';
import assert from 'node:assert/strict';
import {splitSmallSets,smallPass,assessSmall} from './small-set-research.mjs';
import {replayCandidates} from './cohort-server-verify.mjs';
test('Exploratory server replay requires explicit candidate selection and preserves independent cohorts',()=>{
 const config={entryAfterSignal:true},r={id:'x',config,pass:false,full:{accountReturn:3},large:{accountReturn:-1}};
 const report={uploadCandidates:[],results:[r]},protocol={candidates:[{id:'x',config,interval:'30s'}]};
 assert.deepEqual(replayCandidates(report,protocol),[]);
 const selected=replayCandidates(report,protocol,['x']);assert.equal(selected[0].interval,'30s');
 assert.deepEqual(selected[0].replays.map(x=>x.folds),[[1,2,3,4,5,6],[2,3,4,5,6]]);
 assert.equal(selected[0].replays[1].expected.accountReturn,-1);
 assert.throws(()=>replayCandidates(report,protocol,['missing']));
 assert.throws(()=>replayCandidates(report,protocol,['x','x']));
 assert.throws(()=>replayCandidates(report,{candidates:[{id:'x',config:{entryAfterSignal:false}}]},['x']));
});
test('Small sets are deterministic, balanced, CA-disjoint and duplicate/pool independent',()=>{
 const signals=Array.from({length:300},(_,i)=>({chain:'sol',ca:String(i),signalTime:Date.UTC(2026,8,6+i%10)}));
 const p=splitSmallSets(signals),q=splitSmallSets([...signals].reverse().concat(signals[0]));
 assert.deepEqual(p,q);assert.equal(p.size,50);assert.equal(p.reserve,50);
 assert.equal(new Set(p.entries.map(s=>s.ca)).size,300);
 for(const g of p.sets){assert.equal(g.count,50);assert.equal(Object.keys(g.dates).length,10);}
 assert.notDeepEqual(p,splitSmallSets(signals,10));
});
test('Small sample boundaries and insufficient cohorts',()=>{
 assert.throws(()=>splitSmallSets(Array.from({length:49},(_,i)=>({chain:'bsc',ca:String(i),signalTime:1}))),/insufficient/);
 const p=splitSmallSets(Array.from({length:169},(_,i)=>({chain:'bsc',ca:String(i),signalTime:1})));
 assert.equal(p.size,33);assert.equal(p.reserve,4);
});
test('Validation cannot pass on aggregate profit alone or missing/low sample groups',()=>{
 const good={accountReturn:5,totalTrades:10,accountMaxDrawdown:10};
 assert(smallPass(good));assert(!smallPass({...good,totalTrades:9}));assert(!smallPass({...good,accountReturn:0}));
 assert(assessSmall(Array(4).fill(good),good,good).pass);
 assert(!assessSmall([good,good,good,{...good,accountReturn:-1}],good,good).pass);
 assert(!assessSmall(Array(3).fill(good),good,good).pass);
 assert(!assessSmall([good,good,good,{...good,accountReturn:50}],good,good).pass);
 assert(!assessSmall(Array(4).fill(good),{...good,accountReturn:-1},good).pass);
});
