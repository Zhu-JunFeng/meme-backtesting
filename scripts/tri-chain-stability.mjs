/** Frozen, CA-disjoint six-set strategy study. No production writes. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ENGINE_VERSION} from '../packages/engine/dist/index.js';
import {generateStrategyDescription} from '../packages/domain/dist/index.js';
import {hash,fileHash,saveJson} from './cohort-snapshot.mjs';
import {earliestSignals,loadInputs,prepareCandidates,evaluateCohort,median} from './cohort-research.mjs';
import {splitSmallSets} from './small-set-research.mjs';

const read=async p=>JSON.parse(await readFile(p,'utf8'));
const caKey=s=>JSON.stringify([s.chain,s.ca]);
/** Fixed assumptions for all new three-chain searches and validation replays. Percent per side. */
export const RESEARCH_COSTS=Object.freeze({feePercent:1,slippagePercent:1,buyTaxPercent:1,sellTaxPercent:1});
const positive=r=>Number.isFinite(r.accountReturn)&&r.accountReturn>0&&r.totalTrades>=10&&Number.isFinite(r.accountMaxDrawdown)&&r.accountMaxDrawdown<=10;
export function judge(groups,reserve,large,full,stressLarge,withoutBest){
 const values=groups.map(r=>r.accountReturn),mid=median(values);
 const deviation=mid>0?Math.max(...values.map(v=>Math.abs(v-mid)/mid)):Infinity;
 const pass=groups.length===6&&groups.every(positive)&&[reserve,large,full,stressLarge,withoutBest].every(x=>x&&positive(x))&&deviation<=.5;
 return {pass,maxRelativeDeviation:Number.isFinite(deviation)?deviation:null,medianSmallReturn:mid,smallPass:groups.map(positive),reservePass:positive(reserve),largePass:positive(large),fullPass:positive(full),stressPass:!!stressLarge&&positive(stressLarge),withoutBestPass:!!withoutBest&&positive(withoutBest)};
}
export function eligibleForBoth(signals,byInterval){
 const sets=['30s','1m'].map(interval=>new Set(byInterval[interval].filter(p=>p.candles.length).map(p=>caKey(p.symbol))));
 return signals.filter(s=>sets.every(z=>z.has(caKey(s)))&&['30s','1m'].every(interval=>byInterval[interval].some(p=>caKey(p.symbol)===caKey(s)&&p.candles.at(-1).time>s.signalTime)));
}
const rank=(a,b)=>{
 const score=x=>[Math.min(...x.development.map(r=>r.accountReturn)),-Math.max(...x.development.map(r=>r.accountMaxDrawdown))];
 const aa=score(a),bb=score(b);for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i])return bb[i]-aa[i];return a.id.localeCompare(b.id);
};
async function immutable(path,value){try{assert.deepEqual(await read(path),value,'Frozen protocol differs; use a new output directory');}catch(e){if(e.code!=='ENOENT')throw e;await saveJson(path,value);}}
function candidateBases(old,report,chain){
 const ids=[old.candidates[0].id,
  ...[...report.results].sort((a,b)=>b.full.accountReturn-a.full.accountReturn).slice(0,4).map(x=>x.id),
  ...(report.explorationLeaders??[]).slice(0,5).map(x=>x.id)];
 const bases=[...new Set(ids)].map(id=>old.candidates.find(c=>c.id===id)?.config).filter(Boolean).map(x=>structuredClone(x));
 if(chain==='bsc'){
  const best=old.candidates.find(c=>c.id==='30s-E0123')?.config;
  if(best)bases.push({...structuredClone(best),minimumSignalAgeMinutes:30});
 }
 return bases;
}
export async function studyChain(snapshot,prior,output,chain,{seed=20260924,countPerInterval=512}={}){
 assert(['sol','robin','bsc'].includes(chain));assert(Number.isInteger(countPerInterval)&&countPerInterval>=8&&countPerInterval<=512);
 snapshot=resolve(snapshot);output=resolve(output);await mkdir(output,{recursive:true});
 const manifest=await read(resolve(snapshot,'manifest.json')),{checksum,...unsigned}=manifest;
 assert.equal(hash(unsigned),checksum);assert.equal(manifest.engineVersion,ENGINE_VERSION);assert(manifest.completedAt);
 assert.equal(await fileHash(resolve(snapshot,'metadata.json')),manifest.metadataHash);
 const metadata=await read(resolve(snapshot,'metadata.json'));
 const old=await read(resolve(prior,chain,'protocol.json')),oldReport=await read(resolve(prior,chain,'report.json'));
 assert.equal(oldReport.protocolHash,hash(old));
 const signals=earliestSignals(metadata.token_info.filter(s=>s.chain===chain));
 const byInterval={},coverage={};
 for(const interval of ['30s','1m']){
  const loaded=await loadInputs(snapshot,manifest,chain,interval);byInterval[interval]=loaded.inputs;
  coverage[interval]={rows:loaded.rows,invalid:loaded.invalid,caCount:new Set(loaded.inputs.map(p=>caKey(p.symbol))).size};
 }
 const eligible=eligibleForBoth(signals,byInterval);
 const partition=splitSmallSets(eligible,seed,chain==='bsc'?25:50,6,10);
 const included=new Set(eligible.map(caKey)),excluded=signals.filter(s=>!included.has(caKey(s)));
 const costs={...structuredClone(old.costs),...RESEARCH_COSTS},bases=candidateBases(old,oldReport,chain);
 const candidates=prepareCandidates(bases,countPerInterval,seed,costs);
 for(const c of candidates)assert(c.config.entryAfterSignal===true&&c.config.exitConfig.closeAtEnd===true);
 const protocol={version:1,kind:'tri-chain-stability-v1',chain,snapshotHash:checksum,engineVersion:ENGINE_VERSION,seed,costs,partition,
  coverage:{...coverage,signalCAs:signals.length,eligibleCAs:eligible.length,excluded},candidates,
  criteria:{groupCount:6,developmentGroups:[1,2,3],validationGroups:[4,5,6],reserveGroup:7,minTrades:10,maxDrawdown:10,maxRelativeDeviation:.5,shortlist:10,stressSlippagePlus:1},
  scope:'Historical CA-disjoint date-balanced groups on the freshly exported server state. Previously researched market history may overlap. Strict post-signal entry, shared cash, full available candles, terminal close; no future-profit claim.'};
 await immutable(resolve(output,'protocol.json'),protocol);
 const cachePath=resolve(output,'evaluations.json');let cache={};try{cache=await read(cachePath);}catch(e){if(e.code!=='ENOENT')throw e;}
 const run=async(c,folds,variant='base',excludedCa)=>{
  const k=`${c.id}:${folds.join('-')}:${variant}:${excludedCa??''}`;if(cache[k])return cache[k];
  const rows=excludedCa?byInterval[c.interval].filter(p=>caKey(p.symbol)!==excludedCa):byInterval[c.interval];
  const r=evaluateCohort(c,rows,signals,c.interval,folds,partition);cache[k]=r;await saveJson(cachePath,cache);return r;
 };
 const training=[];
 for(const c of candidates){const development=[];for(const fold of [1,2,3]){development.push(await run(c,[fold]));if(!positive(development.at(-1)))break;}
  training.push({id:c.id,interval:c.interval,development,pass:development.length===3&&development.every(positive)});
  if(training.length%25===0)console.log(JSON.stringify({chain,stage:'development',done:training.length,total:candidates.length,pass:training.filter(x=>x.pass).length}));
 }
 await saveJson(resolve(output,'training.json'),training);
 const shortlist=training.filter(x=>x.pass).sort(rank).slice(0,10).map(x=>x.id);
 await immutable(resolve(output,'shortlist.json'),{protocolHash:hash(protocol),ids:shortlist});
 const results=[];
 for(const id of shortlist){const c=candidates.find(x=>x.id===id),development=training.find(x=>x.id===id).development,validation=[];
  for(const fold of [4,5,6])validation.push(await run(c,[fold]));
  const reserve=await run(c,[7]),large=await run(c,[4,5,6,7]),full=await run(c,[1,2,3,4,5,6,7]);
  const small=[...development,...validation],mid=median(small.map(r=>r.accountReturn));
  const preliminary=small.every(positive)&&[reserve,large,full].every(positive)&&mid>0&&small.every(r=>Math.abs(r.accountReturn-mid)/mid<=.5);
  let stressLarge=null;
  if(preliminary){const stressed=structuredClone(c);stressed.config.executionConfig.slippagePercent+=1;stressLarge=await run(stressed,[4,5,6,7],'slippage+1pp');}
  const top=Object.entries(large.audit?.byCa??{}).sort((a,b)=>b[1]-a[1])[0]?.[0];
  const withoutBest=preliminary&&top?await run(c,[4,5,6,7],'without-best-ca',JSON.stringify(top.split(':').slice(0,2))):null;
  const assessment=judge(small,reserve,large,full,stressLarge,withoutBest);
  results.push({id,config:c.config,rules:generateStrategyDescription(c.config).generatedText,development,validation,reserve,large,full,stressLarge,bestCa:top,withoutBest,assessment,pass:assessment.pass});
  await saveJson(resolve(output,'results.partial.json'),results);
  console.log(JSON.stringify({chain,stage:'validation',id,pass:assessment.pass,returns:[...development,...validation,reserve,large,full].map(x=>x.accountReturn)}));
 }
 const passed=results.filter(x=>x.pass).sort((a,b)=>Math.min(...b.development.concat(b.validation).map(r=>r.accountReturn))-Math.min(...a.development.concat(a.validation).map(r=>r.accountReturn)));
 const report={kind:protocol.kind,chain,snapshotHash:checksum,protocolHash:hash(protocol),scope:protocol.scope,coverage:protocol.coverage,partition,candidates:candidates.length,shortlist,results,
  uploadCandidates:passed.slice(0,3).map(x=>x.id),passed:passed.map(x=>x.id),completedAt:new Date().toISOString()};
 await saveJson(resolve(output,'report.json'),report);return report;
}
export async function main(snapshot,prior,output){assert(snapshot&&prior&&output,'SNAPSHOT PRIOR_STUDY OUTPUT required');await mkdir(output,{recursive:true});
 const reports=[];for(const chain of ['bsc','robin','sol']){await saveJson(resolve(output,'state.json'),{stage:'research',chain,at:new Date().toISOString()});reports.push(await studyChain(snapshot,prior,resolve(output,chain),chain));}
 const lines=['# 三链信号后入场、六个小集合与大集合验证','','历史交叉分组研究；此前研究已经查看过部分相同项目，不代表未来收益。',''];
 for(const r of reports){lines.push(`## ${r.chain.toUpperCase()}`,'',`候选 ${r.candidates}；信号 CA ${r.coverage.signalCAs}，可用 CA ${r.coverage.eligibleCAs}，排除 ${r.coverage.excluded.length}；严格达标 ${r.passed.length}。`,'','| 策略 | D1 | D2 | D3 | V1 | V2 | V3 | 剩余 | 独立大集合 | 全量 | 达标 |','| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for(const x of r.results)lines.push(`| ${x.id} | ${[...x.development,...x.validation,x.reserve,x.large,x.full].map(v=>v.accountReturn.toFixed(2)+'%').join(' | ')} | ${x.pass?'是':'否'} |`);if(!r.results.length)lines.push('| — | — | — | — | — | — | — | — | — | — | 无候选通过开发期 |');lines.push('');}
 await writeFile(resolve(output,'report.md'),lines.join('\n'));await saveJson(resolve(output,'state.json'),{stage:'completed',at:new Date().toISOString()});return reports;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main(...process.argv.slice(2));
