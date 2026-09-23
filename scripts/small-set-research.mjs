/** Local-only second-round exploration on previously studied, frozen data. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ENGINE_VERSION} from '../packages/engine/dist/index.js';
import {generateStrategyDescription} from '../packages/domain/dist/index.js';
import {hash,fileHash,saveJson} from './cohort-snapshot.mjs';
import {earliestSignals,dateNumber,loadInputs,prepareCandidates,evaluateCohort,median} from './cohort-research.mjs';

const key=s=>JSON.stringify([s.chain,s.ca]);
export function splitSmallSets(signals,seed=20260923,limit=50){
 const unique=earliestSignals(signals),size=Math.min(limit,Math.floor(unique.length/5));
 assert(size>=10,'Fewer than 50 eligible CAs: insufficient independent small sets');
 const days=new Map();for(const s of unique){const d=dateNumber(s.signalTime);if(!days.has(d))days.set(d,[]);days.get(d).push(s);}
 // Proportional per-day quotas, decided without prices, returns or strategy results.
 const groups=Array.from({length:5},()=>[]),reserve=[];
 for(const [day,rows] of [...days].sort((a,b)=>a[0]-b[0])){
  rows.sort((a,b)=>hash([seed,key(a)]).localeCompare(hash([seed,key(b)])));
  const base=Math.floor(rows.length*size/unique.length);
  for(let g=0;g<5;g++)groups[g].push(...rows.splice(0,base));
  reserve.push(...rows);
 }
 reserve.sort((a,b)=>hash([seed,'reserve',key(a)]).localeCompare(hash([seed,'reserve',key(b)])));
 while(groups.some(g=>g.length<size))for(const g of groups)if(g.length<size)g.push(reserve.shift());
 const entries=groups.flatMap((g,i)=>g.map(s=>({...s,fold:i+1}))).concat(reserve.map(s=>({...s,fold:6})));
 assert.equal(new Set(entries.map(key)).size,unique.length);
 return {size,entries,sets:groups.map((g,i)=>({id:i+1,count:g.length,dates:Object.fromEntries([...new Set(g.map(s=>dateNumber(s.signalTime)))].sort().map(d=>[new Date(d*86400000).toISOString().slice(0,10),g.filter(s=>dateNumber(s.signalTime)===d).length]))})),reserve:reserve.length};
}
export const smallPass=r=>Number.isFinite(r.accountReturn)&&r.accountReturn>0&&r.totalTrades>=10&&Number.isFinite(r.accountMaxDrawdown)&&r.accountMaxDrawdown<=10;
export function assessSmall(validation,large,full){
 const values=validation.map(r=>r.accountReturn),mid=median(values),deviation=mid>0?Math.max(...values.map(v=>Math.abs(v-mid)/mid)):null;
 return {profitableAcrossSets:validation.length===4&&validation.every(smallPass)&&smallPass(large)&&smallPass(full),
  comparableReturns:deviation!==null&&deviation<=.5,relativeDeviation:deviation,
  pass:validation.length===4&&validation.every(smallPass)&&smallPass(large)&&smallPass(full)&&deviation!==null&&deviation<=.5};
}
const brief=r=>({return:r.accountReturn,trades:r.totalTrades,winRate:r.accountWinRate,drawdown:r.accountMaxDrawdown,netPnl:r.netPnl,caCount:r.caCount,poolCount:r.poolCount,endTrades:r.excludedCount,endNetPnl:r.excludedNet});
async function immutable(path,value){try{assert.deepEqual(JSON.parse(await readFile(path,'utf8')),value,'Frozen study differs; use a new output directory');}catch(e){if(e.code!=='ENOENT')throw e;await saveJson(path,value);}}

export async function studyChain(snapshot,previous,output,chain){
 await mkdir(output,{recursive:true});
 const manifest=JSON.parse(await readFile(resolve(snapshot,'manifest.json'),'utf8')),{checksum,...unsigned}=manifest;
 assert.equal(hash(unsigned),checksum);assert.equal(manifest.engineVersion,ENGINE_VERSION);assert(manifest.completedAt);
 assert.equal(await fileHash(resolve(snapshot,'metadata.json')),manifest.metadataHash);
 const metadata=JSON.parse(await readFile(resolve(snapshot,'metadata.json'),'utf8'));
 const old=JSON.parse(await readFile(resolve(previous,chain,'protocol.json'),'utf8'));
 const oldReport=JSON.parse(await readFile(resolve(previous,chain,'report.json'),'utf8'));
 assert.equal(old.snapshotHash,checksum);assert.equal(oldReport.protocolHash,hash(old));
 const signals=earliestSignals(metadata.token_info.filter(s=>s.chain===chain));
 const coverage={},postSets=[];
 // Eligibility frozen identically for both intervals; no future-return features.
 for(const interval of ['30s','1m']){
  const loaded=await loadInputs(snapshot,manifest,chain,interval),gate=new Map(signals.map(s=>[key(s),s.signalTime]));
  const eligible=new Set(loaded.inputs.filter(p=>p.candles.length&&gate.has(key(p.symbol))&&p.candles.at(-1).time>gate.get(key(p.symbol))).map(p=>key(p.symbol)));
  postSets.push(eligible);coverage[interval]={rows:loaded.rows,invalid:loaded.invalid,signalCAs:signals.length,eligibleCAs:eligible.size};
 }
 const included=signals.filter(s=>postSets.every(set=>set.has(key(s)))),partition=splitSmallSets(included);
 const ids=[old.candidates[0].id,...oldReport.explorationLeaders.slice(0,3).map(x=>x.id)];
 const bases=[...new Set(ids)].map(id=>old.candidates.find(c=>c.id===id).config);
 const candidates=prepareCandidates(bases,256,20260923,old.costs);
 const protocol={version:1,chain,snapshotHash:checksum,previousProtocolHash:hash(old),engineVersion:ENGINE_VERSION,seed:20260923,partition,coverage,
  excluded:signals.filter(s=>!included.some(i=>key(i)===key(s))),costs:old.costs,candidates,
  criteria:{minTrades:10,maxDrawdown:10,relativeDeviation:.5,shortlist:5},
  scope:'Previously studied historical data, not blind/time-OOS validation. Signal-date-matched disjoint CA sets; full timelines can overlap. S1 discovery only; S2-S5 and large sets opened after shortlist freeze. Eligibility conditions on available post-signal data; coverage selection bias remains.'};
 await immutable(resolve(output,'protocol.json'),protocol);
 const cachePath=resolve(output,'evaluations.json');let cache={};try{cache=JSON.parse(await readFile(cachePath,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 async function run(c,inputs,folds,suffix='base'){
  const k=`${c.id}:${folds.join('-')}:${suffix}`;if(cache[k])return cache[k];
  const r=evaluateCohort(c,inputs,signals,c.interval,folds,partition);cache[k]=r;await saveJson(cachePath,cache);
  console.log(JSON.stringify({chain,stage:'evaluate',key:k,...brief(r)}));return r;
 }
 const training=[];
 for(const interval of ['30s','1m']){const {inputs}=await loadInputs(snapshot,manifest,chain,interval);
  for(const c of candidates.filter(c=>c.interval===interval)){const r=await run(c,inputs,[1]);training.push({id:c.id,result:r,pass:smallPass(r)});}}
 const leaders=training.filter(x=>x.pass).sort((a,b)=>b.result.accountReturn-a.result.accountReturn||a.result.accountMaxDrawdown-b.result.accountMaxDrawdown||a.id.localeCompare(b.id)).slice(0,5);
 const shortlist={protocolHash:hash(protocol),ids:leaders.map(x=>x.id)};await immutable(resolve(output,'shortlist.json'),shortlist);
 await saveJson(resolve(output,'training.json'),training);
 const results=[];
 for(const interval of ['30s','1m']){const cs=candidates.filter(c=>c.interval===interval&&shortlist.ids.includes(c.id));if(!cs.length)continue;
  const {inputs}=await loadInputs(snapshot,manifest,chain,interval);
  for(const c of cs){const validation=[];for(const g of [2,3,4,5])validation.push(await run(c,inputs,[g]));
   const large=await run(c,inputs,[2,3,4,5,6]),full=await run(c,inputs,[1,2,3,4,5,6]);
   const assessment=assessSmall(validation,large,full),stressed=structuredClone(c);stressed.config.executionConfig.slippagePercent+=1;
   const stress=[];for(const g of [2,3,4,5])stress.push(await run(stressed,inputs,[g],'slippage+1pp'));
   const stressLarge=await run(stressed,inputs,[2,3,4,5,6],'slippage+1pp'),stressFull=await run(stressed,inputs,[1,2,3,4,5,6],'slippage+1pp');
   const byCa=Object.entries(large.audit?.byCa??{}).sort((a,b)=>b[1]-a[1]),best=byCa[0];
   const withoutBest=best?await run(c,inputs.filter(p=>`${p.symbol.chain}:${p.symbol.ca}`!==best[0]),[2,3,4,5,6],'without-best-ca'):null;
   const stressAssessment=assessSmall(stress,stressLarge,stressFull);
   results.push({id:c.id,config:c.config,rules:generateStrategyDescription(c.config).generatedText,discovery:leaders.find(x=>x.id===c.id).result,validation,large,full,assessment,
    stress:{validation:stress,large:stressLarge,full:stressFull,assessment:stressAssessment},bestCa:best,withoutBest,
    pass:assessment.pass&&stressAssessment.pass&&withoutBest!==null&&smallPass(withoutBest)});
   await saveJson(resolve(output,'results.partial.json'),results);
  }
 }
 const report={chain,snapshotHash:checksum,protocolHash:hash(protocol),scope:protocol.scope,coverage,excludedCA:protocol.excluded.length,partition,candidates:candidates.length,shortlist,results,
  exploration:training.sort((a,b)=>b.result.accountReturn-a.result.accountReturn).slice(0,10),passed:results.filter(x=>x.pass).map(x=>x.id),completedAt:new Date().toISOString()};
 await saveJson(resolve(output,'report.json'),report);return report;
}

export async function main(snapshot,previous,output){
 assert(snapshot&&previous&&output,'SNAPSHOT PREVIOUS_STUDY OUTPUT required');await mkdir(output,{recursive:true});
 const state=(stage,extra={})=>saveJson(resolve(output,'state.json'),{stage,...extra,at:new Date().toISOString()});
 try{const reports=[];for(const chain of ['bsc','robin','sol']){await state('research',{chain});const r=await studyChain(resolve(snapshot),resolve(previous),resolve(output,chain),chain);reports.push(r);console.log(JSON.stringify({stage:'complete',chain,passed:r.passed}));}
  const lines=['# 小集合发现与大集合验证','', '复用已研究历史数据，不是时间外盲测，不保证未来盈利。全量指两种周期都有信号后有效行情的 CA；排除项单独报告。',''];
  for(const r of reports){lines.push(`## ${r.chain.toUpperCase()}`,'',`候选 ${r.candidates}；每小组 ${r.partition.size} 个 CA；排除 ${r.excludedCA} 个 CA；最终达标 ${r.passed.length} 个。`,'','| 候选 | S1发现 | S2 | S3 | S4 | S5 | 大集合(不含S1) | 全量 | 达标 |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
   for(const x of r.results)lines.push(`| ${x.id} | ${[x.discovery,...x.validation,x.large,x.full].map(v=>v.accountReturn.toFixed(2)+'%').join(' | ')} | ${x.pass?'是':'否'} |`);
   if(!r.results.length)lines.push('| — | — | — | — | — | — | — | — | 无发现候选通过 |');
   lines.push('','完整费用、交易数、回撤、滑点压力测试及去掉最大盈利 CA 的真实复验，见各链 report.json。','');}
  await writeFile(resolve(output,'report.md'),lines.join('\n'));
  await state('completed');
 }catch(e){await state('failed',{error:String(e)});throw e;}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main(...process.argv.slice(2));
