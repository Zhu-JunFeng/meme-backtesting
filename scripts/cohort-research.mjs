/** Fixed signal-date cohorts. Historical robustness, NOT untouched time-OOS evidence. */
import assert from 'node:assert/strict';
import {readFile,mkdir,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ENGINE_VERSION,validCandle,poolKey} from '../packages/engine/dist/index.js';
import {evaluateWindow} from './offline-strategy-research.mjs';
import {candidatesAround} from './explore-strategy-neighborhood.mjs';
import {gateConfig} from './signal-gated-research.mjs';
import {chains,hash,fileHash,saveJson,candleLines,decodeRow} from './cohort-snapshot.mjs';

const DAY=86400000,OFFSET=8*3600000;
export const dateNumber=t=>Math.floor((t+OFFSET)/DAY);
export const dateText=d=>new Date(d*DAY).toISOString().slice(0,10);
const caKey=s=>JSON.stringify([s.chain,s.ca]);
export function earliestSignals(rows){const map=new Map();for(const r of rows){const t=Number(r.signalTime??r.signal_time);if(r.signalTime==null&&r.signal_time==null||!Number.isFinite(t)||t<0)continue;const k=caKey(r);if(!map.has(k)||t<map.get(k).signalTime)map.set(k,{chain:r.chain,ca:r.ca,signalTime:t});}return [...map.values()].sort((a,b)=>a.signalTime-b.signalTime||caKey(a).localeCompare(caKey(b)));}
export function partitionDays(signals){
 assert(signals.length,'No valid monitoring times');
 const days=signals.map(s=>dateNumber(s.signalTime)),first=Math.min(...days),last=Math.max(...days),span=last-first+1;
 const sizes=Array.from({length:5},(_,i)=>Math.floor(span/5)+(i<span%5?1:0));let cursor=first;
 const folds=sizes.map((size,i)=>{const from=cursor;cursor+=size;return {id:i+1,from:dateText(from),toExclusive:dateText(cursor),fromDay:from,toDay:cursor};});
 const entries=signals.map(s=>({...s,fold:folds.find(f=>dateNumber(s.signalTime)>=f.fromDay&&dateNumber(s.signalTime)<f.toDay)?.id}));
 assert(entries.every(e=>e.fold));
 return {folds,entries,eligible:new Set(days).size>=5&&folds.every(f=>entries.some(e=>e.fold===f.id)),rule:'First signal, Asia/Shanghai calendar day; equal calendar span; no outcome-dependent boundaries'};
}
export function subsets(n){return Array.from({length:(1<<n)-1},(_,i)=>Array.from({length:n},(_,j)=>j+1).filter(j=>(i+1)&(1<<(j-1))));}
export const median=values=>{const a=[...values].sort((a,b)=>a-b),m=Math.floor(a.length/2);return a.length?(a[m]+a[Math.floor((a.length-1)/2)])/2:NaN;};
export const eligible=r=>Number.isFinite(r.accountReturn)&&r.accountReturn>0&&r.totalTrades>=20&&Number.isFinite(r.accountMaxDrawdown)&&r.accountMaxDrawdown<=10;
export function stability(folds,combined){const returns=folds.map(r=>r.accountReturn),mid=median(returns);const dispersion=mid>0?Math.max(...returns.map(v=>Math.abs(v-mid)/mid)):Infinity;
 return {pass:folds.length===4&&folds.every(eligible)&&dispersion<=.5&&combined.accountReturn>0&&combined.accountMaxDrawdown<=10,medianReturn:mid,maxRelativeDeviation:Number.isFinite(dispersion)?dispersion:null};}
export function rank(a,b){const score=x=>[Math.min(...x.folds.map(r=>r.accountReturn)), -Math.max(...x.folds.map(r=>Math.abs(r.accountReturn-median(x.folds.map(s=>s.accountReturn))))),-Math.max(...x.folds.map(r=>r.accountMaxDrawdown))];const aa=score(a),bb=score(b);for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i])return bb[i]-aa[i];return a.id.localeCompare(b.id);}

export function prepareCandidates(bases,count,seed,costs){
 const invalidations=[{mode:'any',enabled:false,conditions:[]},
  {mode:'any',conditions:[{type:'break_fib_invalidation',ratio:.886}]},
  {mode:'any',conditions:[{type:'break_swing_low_invalidation',bufferPercent:2}]},
  {mode:'any',conditions:[{type:'bearish_volume_invalidation',period:10,minRatio:2,minBodyPercent:20}]}];
 const seen=new Set(),result=[];
 for(const [j,interval] of ['30s','1m'].entries())for(const [i,c] of candidatesAround(bases,count,seed+j).entries()){
  const config={...c.config,entryAfterSignal:true,executionConfig:structuredClone(costs),exitConfig:{...c.config.exitConfig,closeAtEnd:true}};
  if(i>=bases.length&&i%5===0)config.invalidationConditionGroup=structuredClone(invalidations[Math.floor(i/5)%invalidations.length]);
  const signature=hash({interval,config});if(seen.has(signature))continue;seen.add(signature);result.push({id:`${interval}-${c.id}`,interval,config});
 }
 return result;
}

export async function loadInputs(directory,manifest,chain,interval){
 const file=manifest.files.find(f=>f.chain===chain&&f.interval===interval&&f.type==='mcap');assert(file);
 const path=resolve(directory,file.name);assert.equal(await fileHash(path),file.sha256,'Local snapshot modified');
 const pools=new Map();let invalid=0,rows=0;
 for await(const row of candleLines(path)){rows++;const {symbol,candle}=decodeRow(chain,row),key=poolKey(symbol);if(!pools.has(key))pools.set(key,{symbol,candles:[]});if(validCandle(candle)){candle.closeTime||=candle.time+(interval==='30s'?30000:60000);candle.valid=true;pools.get(key).candles.push(candle);}else invalid++;}
 assert.equal(rows,file.rows);return {inputs:[...pools.values()],invalid,rows};
}
function basesFor(metadata,chain){
 const versions=metadata.versions.filter(v=>v.strategy_json?.positionConfig?.sizing?.type==='fixed_percent');
 const defaultVersion=versions.find(v=>v.name==='Meme Fib 黄金口袋回撤')??versions[0];assert(defaultVersion,'No usable strategy seed');
 const previous=metadata.previousRuns.filter(r=>r.config_json?.symbols?.some(s=>s.chain===chain)&&r.config_json.positionConfig.sizing.type==='fixed_percent')
  .sort((a,b)=>(b.report_json.returnPercent??-Infinity)-(a.report_json.returnPercent??-Infinity)).slice(0,3);
 return [defaultVersion.strategy_json,...previous.map(r=>r.config_json)];
}
export function evaluateCohort(candidate,inputs,signals,interval,foldIds,partition){
 const refs=new Set(partition.entries.filter(e=>foldIds.includes(e.fold)).map(caKey));
 const selected=inputs.filter(p=>refs.has(caKey(p.symbol))&&p.candles.length);
 if(!selected.length)return {id:candidate.id,foldIds,caCount:refs.size,poolCount:0,accountReturn:0,totalTrades:0,accountMaxDrawdown:0,netPnl:0,empty:true};
 const from=Math.min(...selected.map(p=>p.candles[0].time)),to=Math.max(...selected.map(p=>p.candles.at(-1).time))+(interval==='30s'?30000:60000);
 const config=gateConfig(candidate.config,selected,signals);delete config.pools;delete config.selection;
 const result=evaluateWindow({...candidate,config},selected,from,to,{interval,valueType:'mcap',warmupBars:0,detail:true});
 return {...result,foldIds,caCount:refs.size,poolCount:selected.length};
}

export async function research({snapshot,output,chain,count=256,seed=20260922}){
 assert(chains.includes(chain));assert(Number.isInteger(count)&&count>=4&&count<=256);
 snapshot=resolve(snapshot);output=resolve(output);await mkdir(output,{recursive:true});
 const manifest=JSON.parse(await readFile(resolve(snapshot,'manifest.json'),'utf8'));
 const {checksum,...unsigned}=manifest;assert.equal(hash(unsigned),checksum,'Snapshot manifest changed');
 assert(manifest.completedAt);assert.equal(manifest.engineVersion,ENGINE_VERSION,'Engine changed since freeze');
 assert.equal(await fileHash(resolve(snapshot,'metadata.json')),manifest.metadataHash);
 const metadata=JSON.parse(await readFile(resolve(snapshot,'metadata.json'),'utf8'));
 const signals=earliestSignals(metadata.token_info.filter(t=>t.chain===chain));assert(signals.length);
 const partition=partitionDays(signals),bases=basesFor(metadata,chain),costs=structuredClone(bases[0].executionConfig);
 for(const field of ['feePercent','slippagePercent','buyTaxPercent','sellTaxPercent'])costs[field]=Math.max(...bases.map(b=>b.executionConfig[field]));
 assert.equal(costs.fillMode,'current_bar_close');assert(Object.values(costs).every(v=>typeof v!=='number'||Number.isFinite(v)));
 const protocolPath=resolve(output,'protocol.json');let protocol;
 const generated={version:1,chain,snapshotHash:manifest.checksum,engineVersion:ENGINE_VERSION,seed,partition,costs,
  scope:'Historical CA-disjoint signal-date cohorts; market periods may overlap. D1-D3 used for tuning; D4-D5 untouched in this run, not necessarily unseen in previous research. No future-profit guarantee.',
  candidates:prepareCandidates(bases,count,seed,costs)};
 try{protocol=JSON.parse(await readFile(protocolPath,'utf8'));assert.equal(hash(protocol),hash(generated),'Resume protocol differs; new study required');}catch(e){if(e.code!=='ENOENT')throw e;protocol=generated;await saveJson(protocolPath,protocol);}
 const cachePath=resolve(output,'evaluations.json');let cache={};try{cache=JSON.parse(await readFile(cachePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const training=[];const coverage={};
 async function run(candidate,inputs,folds,suffix='base'){
  const key=`${candidate.id}:${folds.join('-')}:${suffix}`;if(cache[key])return cache[key];
  const r=evaluateCohort(candidate,inputs,signals,candidate.interval,folds,partition);cache[key]=r;await saveJson(cachePath,cache);
  console.log(JSON.stringify({stage:'evaluate',chain,key,return:r.accountReturn,trades:r.totalTrades,seconds:r.seconds}));await new Promise(r=>setImmediate(r));return r;
 }
 // No D4/D5 evaluation occurs before the cross-interval shortlist is frozen.
 for(const interval of ['30s','1m']){
  const loaded=await loadInputs(snapshot,manifest,chain,interval);const known=new Set(signals.map(caKey));
  const inputs=loaded.inputs.filter(p=>known.has(caKey(p.symbol)));
  coverage[interval]={rawRows:loaded.rows,invalid:loaded.invalid,missingSignal:loaded.inputs.filter(p=>!known.has(caKey(p.symbol))).map(p=>p.symbol),noValidCandles:inputs.filter(p=>!p.candles.length).map(p=>p.symbol),noPostSignal:inputs.filter(p=>p.candles.length&&p.candles.at(-1).time<=signals.find(s=>caKey(s)===caKey(p.symbol)).signalTime).map(p=>p.symbol)};
  for(const c of protocol.candidates.filter(c=>c.interval===interval)){const folds=[];for(const f of [1,2,3])folds.push(await run(c,inputs,[f]));training.push({id:c.id,interval,folds,pass:folds.every(eligible)});}
 }
 await saveJson(resolve(output,'coverage.json'),coverage);await saveJson(resolve(output,'training.json'),training);
 const leaders=training.filter(t=>t.pass).sort(rank).slice(0,10);
 const shortlist={protocolHash:hash(protocol),ids:leaders.map(r=>r.id)};
 try{const old=JSON.parse(await readFile(resolve(output,'shortlist.json'),'utf8'));assert.deepEqual(old,shortlist);}catch(e){if(e.code!=='ENOENT')throw e;await saveJson(resolve(output,'shortlist.json'),shortlist);}
 const results=[];
 for(const interval of ['30s','1m']){
  const cs=protocol.candidates.filter(c=>c.interval===interval&&shortlist.ids.includes(c.id));if(!cs.length)continue;
  const loaded=await loadInputs(snapshot,manifest,chain,interval),known=new Set(signals.map(caKey)),inputs=loaded.inputs.filter(p=>known.has(caKey(p.symbol)));
  for(const c of cs){
   const dev=leaders.find(r=>r.id===c.id),validation=[];
   for(const folds of subsets(3).filter(f=>f.length>1))await run(c,inputs,folds);
   for(const f of [4,5])validation.push(await run(c,inputs,[f]));
   const combined=await run(c,inputs,[4,5]);const assessment=stability([...dev.folds.slice(1),...validation],combined);
   const record={id:c.id,interval,config:c.config,development:dev.folds,validation,combined,assessment,pass:partition.eligible&&assessment.pass};
   if(record.pass){
    const stressed={...c,config:structuredClone(c.config)};stressed.config.executionConfig.slippagePercent+=1;
    const sf=[];for(const f of [2,3,4,5])sf.push(await run(stressed,inputs,[f],'slippage+1pp'));
    const sc=await run(stressed,inputs,[4,5],'slippage+1pp');record.stress={folds:sf,combined:sc,assessment:stability(sf,sc)};record.costSensitive=!record.stress.assessment.pass;
    record.combinations=[];for(const folds of subsets(5))record.combinations.push(await run(c,inputs,folds));
    const all=record.combinations.find(r=>r.foldIds.length===5),byCa=Object.entries(all.audit.byCa).sort((a,b)=>b[1]-a[1]),best=byCa[0];
    record.concentration={bestCa:best?.[0],bestPnl:best?.[1],shareOfNet:all.netPnl>0?best?.[1]/all.netPnl:null};
    if(best)record.concentration.withoutBest=await run(c,inputs.filter(p=>`${p.symbol.chain}:${p.symbol.ca}`!==best[0]),[1,2,3,4,5],'without-best-ca');
   }
   results.push(record);await saveJson(resolve(output,'results.partial.json'),results);
  }
 }
 const stable=results.filter(r=>r.pass&&!r.costSensitive).sort((a,b)=>rank({id:a.id,folds:a.validation},{id:b.id,folds:b.validation}));
 const report={chain,protocolHash:hash(protocol),snapshotHash:manifest.checksum,scope:protocol.scope,partition,coverage,candidates:protocol.candidates.length,shortlist,results,
  uploadCandidates:stable.slice(0,3).map(r=>r.id),explorationLeaders:training.sort(rank).slice(0,10),
  conclusion:stable.length?'Historical grouped robustness candidates; not guaranteed future returns':'No strategy met all fixed stability/cost criteria; thresholds were not relaxed',completedAt:new Date().toISOString()};
 await saveJson(resolve(output,'report.json'),report);console.log(JSON.stringify({stage:'complete',chain,stable:stable.length,uploadCandidates:report.uploadCandidates}));return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const [snapshot,output,chain,count='256']=process.argv.slice(2);await research({snapshot,output,chain,count:Number(count)});}
