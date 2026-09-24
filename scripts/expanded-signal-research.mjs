/** Read-only snapshot and offline replay for the expanded FOMO signal cohort. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ENGINE_VERSION,validCandle} from '../packages/engine/dist/index.js';
import {evaluateCohort,earliestSignals} from './cohort-research.mjs';
import {RESEARCH_COSTS} from './tri-chain-stability.mjs';

const SOURCE='fomo_new_project_expanded';
const sha=x=>createHash('sha256').update(x).digest('hex');
const key=x=>JSON.stringify([x.chain,x.ca]);
const read=async p=>JSON.parse(await readFile(p,'utf8'));

export function chronologicalPartition(signals){
 const ordered=[...signals].sort((a,b)=>a.signalTime-b.signalTime||key(a).localeCompare(key(b)));
 assert(ordered.length>=10,'Too few signaled CAs to partition');
 const first=Math.floor(ordered.length*.6);
 const entries=ordered.map((s,i)=>({...s,fold:i<first?1:2}));
 return {entries,counts:[first,ordered.length-first],
  rule:'CA-disjoint, chronological first-signal order: earliest 60% discovery, latest 40% validation; no outcome-dependent boundaries'};
}

export function candidateSet(protocol,perInterval=64){
 assert(Number.isInteger(perInterval)&&perInterval>0&&perInterval<=512);
 const selected=['30s','1m'].flatMap(interval=>protocol.candidates.filter(c=>c.interval===interval).slice(0,perInterval))
  .map(c=>({...c,config:{...c.config,executionConfig:{...c.config.executionConfig,...RESEARCH_COSTS}}}));
 for(const c of selected){
  assert.equal(c.config.entryAfterSignal,true);
  assert.equal(c.config.exitConfig.closeAtEnd,true);
  for(const [field,value] of Object.entries(RESEARCH_COSTS))assert.equal(c.config.executionConfig[field],value);
 }
 return selected;
}

function eligibleSignals(snapshot,chain){
 const signals=snapshot.signals.filter(s=>s.chain===chain);
 const available=new Set(snapshot.inputs[chain]['30s'].filter(p=>p.candles.length).map(p=>key(p.symbol)));
 return {signals,eligible:signals.filter(s=>available.has(key(s))&&['30s','1m'].every(i=>snapshot.inputs[chain][i].some(p=>key(p.symbol)===key(s)&&p.candles.at(-1)?.time>s.signalTime)))};
}

export async function exportSnapshot(output,connectionString){
 assert(connectionString,'DATABASE_URL required for read-only export');
 output=resolve(output);await mkdir(output,{recursive:true});
 const require=createRequire(new URL('../apps/api/package.json',import.meta.url));
 const {Client}=require('pg'),db=new Client({connectionString,application_name:'expanded-signal-readonly-study'});
 const metadata={source:SOURCE,engineVersion:ENGINE_VERSION,exportedAt:new Date().toISOString(),signals:[],inputs:{sol:{'30s':[],'1m':[]},robin:{'30s':[],'1m':[]}}};
 try{
  await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  metadata.snapshot=(await db.query('SELECT txid_current_snapshot()::text AS snapshot')).rows[0].snapshot;
  const infos=(await db.query('SELECT chain,ca,pair,signal_time::float8 AS "signalTime" FROM public.token_info WHERE signal_source=$1 AND chain=ANY($2) ORDER BY chain,ca,pair',[SOURCE,['sol','robin']])).rows;
  metadata.signals=earliestSignals(infos);
  const rows=(await db.query(`SELECT k.chain,k.ca,k.pair_id,k.interval,k.open_time::float8 AS time,k.close_time::float8 AS "closeTime",k.open::float8 AS open,k.high::float8 AS high,k.low::float8 AS low,k.close::float8 AS close,k.volume::float8 AS volume,k.valid
   FROM public.meme_kline k JOIN public.token_info t ON k.chain=t.chain AND k.ca=t.ca AND k.pair_id=t.pair
   WHERE t.signal_source=$1 AND k.chain=ANY($2) AND k.type='mcap' AND k.interval IN ('30s','1m')
   ORDER BY k.chain,k.interval,k.ca,k.pair_id,k.open_time`,[SOURCE,['sol','robin']])).rows;
  const pools=new Map();let invalid=0;
  for(const r of rows){
   const symbol={chain:r.chain,ca:r.ca,pairId:r.pair_id},candle={time:r.time,closeTime:r.closeTime,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume,valid:r.valid};
   if(!r.valid||!validCandle(candle)){invalid++;continue;}
   const k=JSON.stringify([r.chain,r.interval,r.ca,r.pair_id]);
   if(!pools.has(k))pools.set(k,{symbol,candles:[]});
   pools.get(k).candles.push(candle);
  }
  for(const [k,p] of pools){const [chain,interval]=JSON.parse(k);metadata.inputs[chain][interval].push(p);}
  metadata.coverage={rawRows:rows.length,invalidRows:invalid,signalCAs:metadata.signals.length,
   pools:Object.fromEntries(['sol','robin'].map(c=>[c,Object.fromEntries(['30s','1m'].map(i=>[i,metadata.inputs[c][i].length]))]))};
  await db.query('COMMIT');
 }finally{await db.end();}
 const encoded=gzipSync(JSON.stringify(metadata));const path=resolve(output,'snapshot.json.gz');
 await writeFile(path,encoded,{flag:'wx'});
 const manifest={source:SOURCE,engineVersion:ENGINE_VERSION,sha256:sha(encoded),coverage:metadata.coverage,snapshot:metadata.snapshot,exportedAt:metadata.exportedAt};
 await writeFile(resolve(output,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
 return manifest;
}

export async function study(output,priorRoot,{perInterval=64,reportDir=output}={}){
 output=resolve(output);reportDir=resolve(reportDir);await mkdir(reportDir,{recursive:true});
 const manifest=await read(resolve(output,'manifest.json'));
 assert.equal(manifest.engineVersion,ENGINE_VERSION);
 const encoded=await readFile(resolve(output,'snapshot.json.gz'));
 assert.equal(sha(encoded),manifest.sha256,'Snapshot checksum mismatch');
 const snapshot=JSON.parse(gunzipSync(encoded));assert.equal(snapshot.source,SOURCE);
 const reports={source:SOURCE,engineVersion:ENGINE_VERSION,snapshotHash:manifest.sha256,costs:RESEARCH_COSTS,chains:{}};
 for(const chain of ['sol','robin']){
  const prior=await read(resolve(priorRoot,chain,'protocol.json'));
  const priorReport=await read(resolve(priorRoot,chain,'report.json'));
  const candidates=candidateSet(prior,perInterval);
  const {signals,eligible}=eligibleSignals(snapshot,chain);
  const partition=chronologicalPartition(eligible),results=[];
  for(const c of candidates){
   const inputs=snapshot.inputs[chain][c.interval];
   const discovery=evaluateCohort(c,inputs,eligible,c.interval,[1],partition);
   results.push({id:c.id,interval:c.interval,discovery});
   if(results.length%20===0)console.log(JSON.stringify({chain,stage:'discovery',done:results.length,total:candidates.length,best:Math.max(...results.map(x=>x.discovery.accountReturn))}));
   await new Promise(r=>setImmediate(r));
  }
  const ranked=[...results].filter(x=>x.discovery.totalTrades>=5&&x.discovery.accountReturn>0)
   .sort((a,b)=>b.discovery.accountReturn-a.discovery.accountReturn||a.id.localeCompare(b.id));
  const shortlist=ranked.slice(0,5).map(x=>x.id);
  // These pre-existing strategies are evaluated regardless of their new-cohort discovery result.
  const priorIds=[...new Set([...prior.candidates.filter(c=>c.interval==='30s').slice(0,1).map(c=>c.id),
   ...prior.candidates.filter(c=>c.interval==='1m').slice(0,1).map(c=>c.id),
   ...(priorReport.shortlist??[]),...shortlist])];
  const validated=[];
  for(const id of priorIds){const c=candidates.find(x=>x.id===id);if(!c)continue;
   const input=snapshot.inputs[chain][c.interval];
   const find=results.find(x=>x.id===id);
   const validation=evaluateCohort(c,input,eligible,c.interval,[2],partition);
   const full=evaluateCohort(c,input,eligible,c.interval,[1,2],partition);
   validated.push({id,interval:c.interval,config:c.config,discovery:find.discovery,validation,full,
    positiveAll:find.discovery.accountReturn>0&&validation.accountReturn>0&&full.accountReturn>0,
    sampleAdequate:[find.discovery,validation].every(r=>r.totalTrades>=5)});
   console.log(JSON.stringify({chain,stage:'validation',id,returns:[find.discovery,validation,full].map(r=>r.accountReturn),trades:[find.discovery,validation].map(r=>r.totalTrades)}));
  }
  reports.chains[chain]={coverage:{signals:signals.length,eligible:eligible.length,excluded:signals.length-eligible.length,
   pools:Object.fromEntries(['30s','1m'].map(i=>[i,snapshot.inputs[chain][i].length]))},partition:{counts:partition.counts,
   boundarySignalTime:partition.entries[partition.counts[0]-1]?.signalTime},
   candidates:candidates.length,shortlist,discoveryLeaders:ranked.slice(0,10),validated};
 }
 reports.completedAt=new Date().toISOString();
 await writeFile(resolve(reportDir,'report.json'),JSON.stringify(reports,null,2),{flag:'wx'});
 return reports;
}

export async function stress(output,reportDir,ids){
 output=resolve(output);reportDir=resolve(reportDir);
 const manifest=await read(resolve(output,'manifest.json'));
 const encoded=await readFile(resolve(output,'snapshot.json.gz'));
 assert.equal(sha(encoded),manifest.sha256);
 const snapshot=JSON.parse(gunzipSync(encoded)),report=await read(resolve(reportDir,'report.json'));
 assert.equal(report.snapshotHash,manifest.sha256);
 const results=[];
 for(const chain of ['sol','robin']){
  const selected=report.chains[chain].validated.filter(v=>ids.includes(v.id));
  if(!selected.length)continue;
  const {eligible}=eligibleSignals(snapshot,chain),signals=eligible,partition=chronologicalPartition(eligible);
  for(const v of selected){
   const candidate={id:v.id,interval:v.interval,config:v.config};
   const inputs=snapshot.inputs[chain][v.interval];
   const stressed=structuredClone(candidate);stressed.config.executionConfig.slippagePercent+=1;
   const folds=[1,2],costStress=folds.map(f=>evaluateCohort(stressed,inputs,signals,v.interval,[f],partition));
   const withoutBest=folds.map((f,i)=>{
    const source=f===1?v.discovery:v.validation;
    const ca=source.topCaKey?.split(':').slice(1).join(':');
    return ca?{ca,result:evaluateCohort(candidate,inputs.filter(p=>p.symbol.ca!==ca),signals,v.interval,[f],partition)}:null;
   });
   const topFull=v.full.topCaKey?.split(':').slice(1).join(':');
   const withoutBestFull=topFull?{ca:topFull,result:evaluateCohort(candidate,inputs.filter(p=>p.symbol.ca!==topFull),signals,v.interval,folds,partition)}:null;
   results.push({chain,id:v.id,baseline:[v.discovery.accountReturn,v.validation.accountReturn,v.full.accountReturn],
    costStress:costStress.map(x=>x.accountReturn),costStressFull:evaluateCohort(stressed,inputs,signals,v.interval,folds,partition).accountReturn,
    withoutBest:withoutBest.map(x=>x&&{ca:x.ca,accountReturn:x.result.accountReturn,trades:x.result.totalTrades}),
    withoutBestFull:withoutBestFull&&{ca:withoutBestFull.ca,accountReturn:withoutBestFull.result.accountReturn,trades:withoutBestFull.result.totalTrades}});
  }
 }
 await writeFile(resolve(reportDir,'stress.json'),JSON.stringify({snapshotHash:manifest.sha256,results},null,2),{flag:'wx'});
 return results;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [mode,output,priorRoot,perInterval='64',reportDir]=process.argv.slice(2);
 if(mode==='export')console.log(JSON.stringify(await exportSnapshot(output,process.env.DATABASE_URL)));
 else if(mode==='study')console.log(JSON.stringify({completedAt:(await study(output,priorRoot,{perInterval:Number(perInterval),reportDir:reportDir??output})).completedAt}));
 else if(mode==='stress')console.log(JSON.stringify(await stress(output,priorRoot,perInterval.split(','))));
 else throw Error('Usage: expanded-signal-research.mjs export SNAPSHOT_DIR | study SNAPSHOT_DIR PRIOR_STUDY [PER_INTERVAL] [REPORT_DIR]');
}
