import test from 'node:test';
import assert from 'node:assert/strict';
import {coveredSignals,researchCandidates,waitingVariants,robinExitVariants} from './all-signal-research.mjs';

test('all signal sources use earliest time and exclude CA lacking post-signal candles',()=>{
 const events=[{chain:'sol',ca:'A',signalTime:200,signal_source:'expanded'},
  {chain:'sol',ca:'A',signalTime:100,signal_source:'original'},
  {chain:'sol',ca:'B',signalTime:200},{chain:'robin',ca:'C',signalTime:100}];
 const pool=(ca,last)=>({symbol:{chain:'sol',ca,pairId:ca},candles:[{time:last}]});
 const byInterval={'30s':[pool('A',300),pool('B',200)],'1m':[pool('A',300),pool('B',300)]};
 const r=coveredSignals(events,byInterval,'sol');
 assert.deepEqual(r.signals,[{chain:'sol',ca:'A',signalTime:100}]);
 assert.deepEqual(r.excluded,[{chain:'sol',ca:'B',signalTime:200}]);
});

test('full-account candidates retain prior and expanded leaders with strict costs',()=>{
 const config={entryAfterSignal:true,exitConfig:{closeAtEnd:true},executionConfig:{feePercent:.3,slippagePercent:.3,buyTaxPercent:0,sellTaxPercent:0}};
 const prior={candidates:[{id:'30s-E0001',interval:'30s',config},{id:'30s-E0002',interval:'30s',config},{id:'1m-E0345',interval:'1m',config}]};
 const old={results:[{id:'30s-E0002',full:{accountReturn:3}}]},expanded={chains:{robin:{shortlist:['1m-E0345']}}};
 const result=researchCandidates(prior,old,expanded,'robin',1);
 assert.deepEqual(result.map(x=>x.id),['30s-E0001','1m-E0345','30s-E0002']);
 assert(result.every(x=>x.config.executionConfig.feePercent===1&&x.config.executionConfig.slippagePercent===1));
});

test('bounded variants change only causal signal wait and reentry settings',()=>{
 const config={entryAfterSignal:true,exitConfig:{closeAtEnd:true},positionConfig:{allowReentry:true},executionConfig:{feePercent:.3,slippagePercent:.3,buyTaxPercent:0,sellTaxPercent:0}};
 const prior={candidates:[{id:'30s-E0001',interval:'30s',config}]};
 const variants=waitingVariants(prior,[{id:'30s-E0001',returnPercent:-1}]);
 assert.equal(variants.length,7);
 assert(variants.every(x=>x.config.entryAfterSignal&&x.config.executionConfig.feePercent===1));
 assert(variants.every(x=>[0,5,30,120].includes(x.config.minimumSignalAgeMinutes)));
 assert(variants.every(x=>x.config.positionConfig.allowReentry===false||x.config.minimumSignalAgeMinutes>0));
 assert.equal(config.executionConfig.feePercent,.3);
});

test('ROBIN exit grid is bounded and preserves post-signal entry and costs',()=>{
 const config={entryAfterSignal:true,exitConfig:{closeAtEnd:true,takeProfit:{type:'risk_reward',ratio:2},maxHoldingBars:60},positionConfig:{allowReentry:true},executionConfig:{feePercent:.3,slippagePercent:.3,buyTaxPercent:0,sellTaxPercent:0}};
 const variants=robinExitVariants({candidates:[{id:'1m-E0005',interval:'1m',config}]});
 assert.equal(variants.length,54);
 assert.equal(new Set(variants.map(x=>x.id)).size,54);
 assert(variants.every(x=>x.config.entryAfterSignal&&x.config.positionConfig.allowReentry===false));
 assert(variants.every(x=>x.config.executionConfig.feePercent===1&&x.config.executionConfig.slippagePercent===1));
});
