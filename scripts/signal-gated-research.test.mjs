import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gateConfig,splitSignals} from './signal-gated-research.mjs';
test('gates retain exact signal timestamps and fail closed on missing CA',()=>{
 const config={exitConfig:{closeAtEnd:false}},inputs=[{symbol:{chain:'sol',ca:'A',pairId:'p'}}];
 assert.throws(()=>gateConfig(config,inputs,[]));
 const result=gateConfig(config,inputs,[{chain:'sol',ca:'A',signalTime:123},{chain:'sol',ca:'B',signalTime:456}]);
 assert.equal(result.entrySignals.length,1);assert.equal(result.entrySignals[0].signalTime,123);assert.equal(result.exitConfig.closeAtEnd,true);assert.equal(config.exitConfig.closeAtEnd,false);
});
test('discovery cohorts do not overlap or split equal signal times',()=>{
 const signals=Array.from({length:10},(_,i)=>({ca:String(i),signalTime:Math.floor(i/2)}));
 const r=splitSignals(signals);assert(r.training.length&&r.validation.length);
 assert(r.training.every(s=>s.signalTime<r.cutoff));assert(r.validation.every(s=>s.signalTime>=r.cutoff));assert.equal(r.training.length+r.validation.length,signals.length);
});
