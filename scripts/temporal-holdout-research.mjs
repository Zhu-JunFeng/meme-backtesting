/** Read frozen local files only. One development winner, then one held-out evaluation. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ENGINE_VERSION} from '../packages/engine/dist/index.js';
import {generateStrategyDescription} from '../packages/domain/dist/index.js';
import {earliestSignals,loadInputs,prepareCandidates} from './cohort-research.mjs';
import {hash,fileHash,saveJson} from './cohort-snapshot.mjs';
import {gateConfig} from './signal-gated-research.mjs';
import {evaluateWindow} from './offline-strategy-research.mjs';

const key=s=>JSON.stringify([s.chain,s.ca]);
export const COSTS={initialCapital:10000,feePercent:1,slippagePercent:1,buyTaxPercent:1,sellTaxPercent:1,fillMode:'current_bar_close'};
export function baseStrategy(){return {schemaVersion:1,entryAfterSignal:true,minimumSignalAgeMinutes:0,
 impulseCondition:{type:'impulse_fractal_swing',leftBars:2,rightBars:2,lookbackBars:200,minGainPercent:80,maxDurationBars:100,requireVolumeExpansion:false},
 entryConditionGroup:{mode:'all',conditions:[{type:'fib_retracement',zoneLow:.618,zoneHigh:.786},{type:'volume_contraction',period:10,maxRatio:.7}]},
 invalidationConditionGroup:{mode:'any',conditions:[{type:'break_fib_invalidation',ratio:.886},{type:'break_swing_low_invalidation',bufferPercent:0}]},
 addConditionGroup:{mode:'all',enabled:false,conditions:[]},
 exitConfig:{stopLoss:{type:'percent',value:10},takeProfit:{type:'risk_reward',ratio:2},maxHoldingBars:120,closeAtEnd:true,profitLock:{enabled:false,tiers:[]}},
 positionConfig:{mode:'single_entry',maxEntries:1,maxConcurrentPositions:3,allowReentry:false,sizing:{type:'fixed_percent',value:2}},executionConfig:{...COSTS}};}
export function splitCohort(signals,ratio=.7){
 assert(typeof ratio==='number'&&Number.isFinite(ratio)&&ratio>0&&ratio<1,'Split ratio must be between 0 and 1');const ordered=earliestSignals(signals);assert(ordered.length>=2,'Insufficient CA signals');
 const index=Math.min(ordered.length-1,Math.max(1,Math.floor(ordered.length*ratio))),cutoff=ordered[index].signalTime;
 const development=ordered.filter(s=>s.signalTime<cutoff),validation=ordered.filter(s=>s.signalTime>=cutoff);
 assert(development.length&&validation.length,'Equal signal timestamps cannot be split');
 return {cutoff,development,validation};
}
export function selectInputs(inputs,signals,end){
 const keys=new Set(signals.map(key));
 return inputs.filter(p=>keys.has(key(p.symbol))).map(p=>({symbol:p.symbol,candles:p.candles.filter(c=>c.time<end&&c.closeTime<=end)})).filter(p=>p.candles.length);
}
export function rankDevelopment(rows){return [...rows].filter(r=>r.totalTrades>=10&&r.accountMaxDrawdown<=20&&Number.isFinite(r.accountReturn)).sort((a,b)=>b.accountReturn-a.accountReturn||a.accountMaxDrawdown-b.accountMaxDrawdown||a.id.localeCompare(b.id));}
export function accepted(development,validation){return development.accountReturn>0&&validation.accountReturn>0&&development.totalTrades>=10&&validation.totalTrades>=10&&development.accountMaxDrawdown<=20&&validation.accountMaxDrawdown<=20;}
export function candidateGrid(count=96){
 assert(Number.isInteger(count)&&count>=2&&count<=256);const all=prepareCandidates([baseStrategy()],256,20261007,COSTS),out=[];
 for(const interval of ['30s','1m']){const group=all.filter(c=>c.interval===interval);for(let i=0;i<count;i++)out.push(group[Math.floor(i*(group.length-1)/(count-1))]);}
 return out;
}
export function shardCandidates(candidates,shard){
 if(!shard)return candidates;
 assert(Number.isInteger(shard.index)&&Number.isInteger(shard.total)&&shard.total>=1&&shard.total<=8&&shard.index>=0&&shard.index<shard.total,'Invalid shard');
 return candidates.filter((_,i)=>i%shard.total===shard.index);
}
export async function study({snapshot,output,chain,count=96,shard,splitRatio=.7}){
 snapshot=resolve(snapshot);output=resolve(output);await mkdir(output,{recursive:true});
 const manifest=JSON.parse(await readFile(resolve(snapshot,'manifest.json'),'utf8')),metadata=JSON.parse(await readFile(resolve(snapshot,'metadata.json'),'utf8'));
 const {checksum,...unsigned}=manifest;assert.equal(hash(unsigned),checksum);assert.equal(manifest.engineVersion,ENGINE_VERSION);assert.equal(await fileHash(resolve(snapshot,'metadata.json')),manifest.metadataHash);
 const asOf=Date.parse(manifest.startedAt),allSignals=earliestSignals([...metadata.token_info,...metadata.token_signal_events,...(metadata.live_signals??[])].filter(s=>s.chain===chain));
 const loaded={},available=new Set();for(const interval of ['30s','1m']){
  const r=await loadInputs(snapshot,manifest,chain,interval);r.inputs=selectInputs(r.inputs,allSignals,asOf);loaded[interval]=r;
  for(const p of r.inputs)available.add(key(p.symbol));
 }
 const signals=allSignals.filter(s=>available.has(key(s))),partition=splitCohort(signals,splitRatio),candidates=candidateGrid(count);
 const protocol={version:1,engineVersion:ENGINE_VERSION,snapshotHash:checksum,chain,asOf,partition,candidates,costs:COSTS,...(splitRatio!==.7?{splitRatio}:{}),
  scope:'Historical chronological CA-disjoint holdout; old history has been studied before, so NOT genuinely unseen prospective validation.',
  rule:`${Number((splitRatio*100).toFixed(4))}% earliest discovered CAs develop, later ${Number(((1-splitRatio)*100).toFixed(4))}% validate; tied times stay together. Development candles must close by cutoff; pre-signal history warms indicators, all entries strictly after earliest signal. All pools of a CA stay together. One winner frozen by development return (>=10 trades, <=20% drawdown) BEFORE validation. No validation-driven reselection. Last available candle closes positions. Existing engine gap fill unchanged.`,
  coverage:Object.fromEntries(Object.entries(loaded).map(([interval,r])=>[interval,{rows:r.rows,invalid:r.invalid,pools:r.inputs.length,cas:new Set(r.inputs.map(p=>key(p.symbol))).size}])),
  signalsWithoutCandles:allSignals.filter(s=>!available.has(key(s)))};
 const pp=resolve(output,'protocol.json');try{const old=JSON.parse(await readFile(pp,'utf8'));assert.equal(hash(old),hash(protocol),'Protocol changed');}catch(e){if(e.code!=='ENOENT')throw e;assert(!shard,'Freeze protocol with coordinator before starting shards');await writeFile(pp,JSON.stringify(protocol,null,2),{flag:'wx'});}
 let training=[];try{training=JSON.parse(await readFile(resolve(output,'development.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const known=new Set(training.map(r=>r.id));for(const name of (await readdir(output)).filter(n=>/^development-shard-\d+-of-\d+\.json$/.test(n)).sort()){
  const data=JSON.parse(await readFile(resolve(output,name),'utf8'));assert.equal(data.protocolHash,hash(protocol),'Shard protocol differs');
  for(const r of data.rows)if(!known.has(r.id)){assert(candidates.some(c=>c.id===r.id));training.push(r);known.add(r.id);}
 }
 const run=(candidate,ss,end,detail=false)=>{
  const inputs=selectInputs(loaded[candidate.interval].inputs,ss,end);assert(inputs.length,'Cohort has no candles');
  const from=Math.min(...inputs.map(p=>p.candles[0].time));
  return {...evaluateWindow({...candidate,config:gateConfig(candidate.config,inputs,signals)},inputs,from,end,{interval:candidate.interval,warmupBars:0,detail}),caCount:new Set(inputs.map(p=>key(p.symbol))).size,poolCount:inputs.length};
 };
 for(const c of shardCandidates(candidates,shard)){if(training.some(r=>r.id===c.id))continue;const r=run(c,partition.development,partition.cutoff);training.push(r);
  if(shard)await saveJson(resolve(output,`development-shard-${shard.index}-of-${shard.total}.json`),{protocolHash:hash(protocol),rows:training});else await saveJson(resolve(output,'development.json'),training);
  console.log(JSON.stringify({stage:'development',chain,done:training.length,total:candidates.length,id:c.id,return:r.accountReturn,trades:r.totalTrades,seconds:r.seconds}));await new Promise(r=>setImmediate(r));
 }
 if(shard)return {developmentOnly:true};
 assert.equal(training.length,candidates.length);await saveJson(resolve(output,'development.json'),training);
 const leader=rankDevelopment(training)[0],frozen={protocolHash:hash(protocol),winner:leader?.id??null};
 const fp=resolve(output,'frozen-winner.json');try{assert.deepEqual(JSON.parse(await readFile(fp,'utf8')),frozen);}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(fp,JSON.stringify(frozen,null,2),{flag:'wx'});}
 if(!leader){const report={chain,protocolHash:hash(protocol),passed:false,reason:'No development candidate meets sample/risk threshold',completedAt:new Date().toISOString()};await saveJson(resolve(output,'report.json'),report);return report;}
 const winner=candidates.find(c=>c.id===leader.id),development=run(winner,partition.development,partition.cutoff,true),validation=run(winner,partition.validation,asOf,true);
 const stressed=structuredClone(winner);stressed.config.executionConfig.slippagePercent+=1;
 const stress=run(stressed,partition.validation,asOf,true);
 const best=Object.entries(validation.audit.byCa).sort((a,b)=>b[1]-a[1])[0];
 const withoutBestSignals=partition.validation.filter(s=>`${s.chain}:${s.ca}`!==best?.[0]);
 const withoutBest=best&&withoutBestSignals.length?run(winner,withoutBestSignals,asOf,true):null;
 const report={chain,protocolHash:hash(protocol),snapshotHash:checksum,scope:protocol.scope,splitRatio,cutoff:partition.cutoff,asOf,config:winner.config,id:winner.id,interval:winner.interval,strategyDescription:generateStrategyDescription(winner.config),
  development,validation,stress,withoutBest,bestValidationCa:best,
  passed:accepted(development,validation),stressPassed:stress.accountReturn>0,withoutBestPassed:!!withoutBest&&withoutBest.accountReturn>0,
  warning:'Finite historical search, not profit guarantee. Validation never used to replace frozen winner. Gap-filled candles and terminal closes must be reviewed before paper deployment.',completedAt:new Date().toISOString()};
 await saveJson(resolve(output,'report.json'),report);console.log(JSON.stringify({stage:'complete',chain,id:winner.id,passed:report.passed,development:development.accountReturn,validation:validation.accountReturn,stress:stress.accountReturn}));return report;
}
export function parseStudyArgs(args){
 const options=args.filter(a=>a.startsWith('--'));assert(options.length<=1&&options.every(a=>a.startsWith('--split=')),'Usage: SNAPSHOT OUTPUT CHAIN [COUNT] [SHARD/TOTAL] [--split=0.5]');
 const splitRatio=options.length?Number(options[0].slice('--split='.length)):.7;assert(Number.isFinite(splitRatio)&&splitRatio>0&&splitRatio<1,'Invalid split ratio');
 const [snapshot,output,chain,count='96',shardArg,...extra]=args.filter(a=>!a.startsWith('--'));assert(snapshot&&output&&chain&&!extra.length,'Missing or extra arguments');
 const shard=shardArg?{index:Number(shardArg.split('/')[0]),total:Number(shardArg.split('/')[1])}:undefined;
 return {snapshot,output,chain,count:Number(count),shard,splitRatio};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await study(parseStudyArgs(process.argv.slice(2)));
