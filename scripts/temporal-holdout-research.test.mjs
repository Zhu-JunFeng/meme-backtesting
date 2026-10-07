import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitCohort,selectInputs,rankDevelopment,accepted,candidateGrid,shardCandidates,COSTS} from './temporal-holdout-research.mjs';
test('signal duplicates and tied timestamps never cross cohort boundary',()=>{
 const rows=Array.from({length:10},(_,i)=>({chain:'sol',ca:String(i),signalTime:Math.floor(i/2)*100}));rows.push({...rows[0],signalTime:900});
 const p=splitCohort(rows);assert.equal(p.cutoff,300);assert.equal(p.development.length,6);assert.equal(p.validation.length,4);assert.equal(p.development[0].signalTime,0);
 assert.throws(()=>splitCohort(rows.map(r=>({...r,signalTime:1}))));
});
test('all CA pools stay together and development cannot consume bars closing after cutoff',()=>{
 const inputs=['p1','p2','p3'].map((pairId,i)=>({symbol:{chain:'sol',ca:i===2?'B':'A',pairId},candles:[{time:0,closeTime:30},{time:30,closeTime:60},{time:60,closeTime:90}]}));
 const out=selectInputs(inputs,[{chain:'sol',ca:'A'}],45);assert.equal(out.length,2);assert(out.every(p=>p.candles.length===1));assert.equal(inputs[0].candles.length,3);
});
test('selection uses development only with fixed risk and sample gate',()=>{
 const row=(id,r,t=10,d=20)=>({id,accountReturn:r,totalTrades:t,accountMaxDrawdown:d});
 assert.deepEqual(rankDevelopment([row('A',2),row('B',100,9),row('C',100,10,21),row('D',3)]).map(r=>r.id),['D','A']);
 assert(accepted(row('a',1),row('b',.1)));assert(!accepted(row('a',1),row('b',0)));assert(!accepted(row('a',1),row('b',1,9)));
});
test('candidate grid deterministic, signal gated, costs fixed and no risk-percent sizing',()=>{
 const grid=candidateGrid();assert.equal(grid.length,192);assert.deepEqual(grid,candidateGrid());assert.equal(new Set(grid.map(c=>c.id)).size,192);
 for(const c of grid){assert.equal(c.config.entryAfterSignal,true);assert.equal(c.config.minimumSignalAgeMinutes,0);assert.equal(c.config.exitConfig.closeAtEnd,true);assert.equal(c.config.positionConfig.sizing.type,'fixed_percent');assert.deepEqual(c.config.executionConfig,COSTS);}
});
test('development shards are disjoint and cover exactly the frozen grid',()=>{
 const grid=candidateGrid(),parts=Array.from({length:4},(_,index)=>shardCandidates(grid,{index,total:4})).flat();
 assert.equal(parts.length,grid.length);assert.deepEqual(parts.map(c=>c.id).sort(),grid.map(c=>c.id).sort());assert.throws(()=>shardCandidates(grid,{index:4,total:4}));
});
