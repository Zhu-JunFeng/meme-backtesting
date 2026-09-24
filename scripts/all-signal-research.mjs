/** All currently signaled SOL/ROBIN CAs: immutable export and full-account exploration. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {readFile,mkdir,rename} from 'node:fs/promises';
import {createGzip} from 'node:zlib';
import {finished} from 'node:stream/promises';
import {once} from 'node:events';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ENGINE_VERSION,validCandle} from '../packages/engine/dist/index.js';
import {decodeRow,fileHash,hash,saveJson} from './cohort-snapshot.mjs';
import {earliestSignals,loadInputs} from './cohort-research.mjs';
import {candidateSet} from './expanded-signal-research.mjs';
import {gateConfig} from './signal-gated-research.mjs';
import {evaluateWindow} from './offline-strategy-research.mjs';

const CHAINS=['sol','robin'],INTERVALS=['30s','1m'];
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const caKey=x=>JSON.stringify([x.chain,x.ca]);

export function coveredSignals(events,byInterval,chain){
 const signals=earliestSignals(events.filter(e=>e.chain===chain));
 const available=INTERVALS.map(i=>new Map(byInterval[i].filter(p=>p.candles.length).map(p=>[caKey(p.symbol),p.candles.at(-1).time])));
 const included=signals.filter(s=>available.every(m=>(m.get(caKey(s))??-Infinity)>s.signalTime));
 return {signals:included,excluded:signals.filter(s=>!included.some(x=>caKey(x)===caKey(s)))};
}

export function researchCandidates(prior,priorReport,expandedReport,chain,perInterval){
 const all=candidateSet(prior,perInterval),byId=new Map(all.map(c=>[c.id,c]));
 const wanted=[...(priorReport?.results??[]).filter(x=>x.full).sort((a,b)=>b.full.accountReturn-a.full.accountReturn).slice(0,10).map(x=>x.id),
  ...(expandedReport.chains[chain]?.shortlist??[])];
 for(const id of wanted){const source=prior.candidates.find(c=>c.id===id);if(source&&!byId.has(id))byId.set(id,candidateSet({candidates:[source]},1)[0]);}
 return [...byId.values()];
}

export function waitingVariants(prior,baseResults,{leaders=3}={}){
 const chosen=[...baseResults].sort((a,b)=>b.returnPercent-a.returnPercent).slice(0,leaders),variants=[];
 for(const result of chosen){const source=prior.candidates.find(c=>c.id===result.id);assert(source,`Missing prior candidate ${result.id}`);
  const baseline=candidateSet({candidates:[source]},1)[0];
  for(const delay of [0,5,30,120])for(const reentry of [...new Set([baseline.config.positionConfig.allowReentry,false])]){
   if(delay===0&&reentry===baseline.config.positionConfig.allowReentry)continue;
   const c=structuredClone(baseline);c.id=`${baseline.id}-D${delay}-R${Number(reentry)}`;
   c.config.minimumSignalAgeMinutes=delay;c.config.positionConfig.allowReentry=reentry;variants.push(c);
  }
 }
 return variants;
}

export function robinExitVariants(prior){
 const source=prior.candidates.find(c=>c.id==='1m-E0005');assert(source,'Missing ROBIN 1m-E0005');
 const baseline=candidateSet({candidates:[source]},1)[0],variants=[];
 for(const delay of [60,90,120,150,180,240])for(const reward of [1.5,2,3])for(const holding of [30,60,120]){
  const c=structuredClone(baseline);c.id=`${source.id}-D${delay}-RR${reward}-H${holding}`;
  c.config.minimumSignalAgeMinutes=delay;c.config.positionConfig.allowReentry=false;
  c.config.exitConfig.takeProfit={type:'risk_reward',ratio:reward};c.config.exitConfig.maxHoldingBars=holding;
  variants.push(c);
 }
 return variants;
}

export async function exportAllSignals(output,connectionString){
 assert(connectionString,'DATABASE_URL required');output=resolve(output);
 const require=createRequire(new URL('../apps/api/package.json',import.meta.url)),{Client}=require('pg');
 const db=new Client({connectionString,application_name:'all-signal-readonly-export'});
 await mkdir(resolve(output,'..'),{recursive:true});
 const stage=output+'.partial-'+process.pid;await mkdir(stage,{recursive:false});
 const manifest={version:1,scope:'all token_signal_events SOL/ROBIN, 30s/1m mcap, consistent read-only snapshot',engineVersion:ENGINE_VERSION,createdAt:new Date().toISOString(),files:[]};
 try{
  await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  manifest.snapshot=(await db.query('SELECT txid_current_snapshot()::text AS snapshot')).rows[0].snapshot;
  const metadata={token_signal_events:(await db.query('SELECT chain,ca,signal_source,signal_time::float8 AS "signalTime",id FROM token_signal_events WHERE chain=ANY($1) AND signal_time IS NOT NULL ORDER BY chain,ca,signal_time,id',[CHAINS])).rows};
  await saveJson(resolve(stage,'metadata.json'),metadata);manifest.metadataHash=await fileHash(resolve(stage,'metadata.json'));
  for(const chain of CHAINS)for(const interval of INTERVALS){
   const name=`${chain}-${interval}-mcap.jsonl.gz`,path=resolve(stage,name),gzip=createGzip(),sink=createWriteStream(path,{flags:'wx'}),done=finished(sink);
   gzip.on('error',e=>sink.destroy(e));gzip.pipe(sink);
   let rows=0,valid=0,firstTime=Infinity,lastTime=-Infinity;const digest=createHash('sha256');
   await db.query(`DECLARE signal_market_rows NO SCROLL CURSOR FOR
    SELECT k.ca,k.pair_id,k.open_time::float8,k.close_time::float8,k.open::float8,k.high::float8,k.low::float8,k.close::float8,k.volume::float8,k.valid
    FROM meme_kline k WHERE k.chain=$1 AND k.interval=$2 AND k.type='mcap'
    AND EXISTS (SELECT 1 FROM token_signal_events s WHERE s.chain=k.chain AND s.ca=k.ca AND s.signal_time IS NOT NULL)
    ORDER BY k.ca,k.pair_id,k.open_time`,[chain,interval]);
   try{for(;;){const batch=await db.query('FETCH 10000 FROM signal_market_rows');if(!batch.rowCount)break;
    const lines=[];for(const r of batch.rows){const a=[r.ca,r.pair_id,r.open_time,r.close_time,r.open,r.high,r.low,r.close,r.volume,r.valid],line=JSON.stringify(a)+'\n';
     lines.push(line);digest.update(line);rows++;if(validCandle(decodeRow(chain,a).candle))valid++;firstTime=Math.min(firstTime,Number(r.open_time));lastTime=Math.max(lastTime,Number(r.open_time));}
    if(!gzip.write(lines.join('')))await once(gzip,'drain');
   }gzip.end();await done;}catch(e){gzip.destroy();sink.destroy();await done.catch(()=>{});throw e;}
   await db.query('CLOSE signal_market_rows');
   manifest.files.push({chain,interval,type:'mcap',name,rows,valid,firstTime:rows?firstTime:null,lastTime:rows?lastTime:null,sha256:await fileHash(path),dataHash:digest.digest('hex')});
   console.log(JSON.stringify({stage:'snapshot',...manifest.files.at(-1)}));
  }
  await db.query('COMMIT');manifest.completedAt=new Date().toISOString();manifest.checksum=hash(manifest);await saveJson(resolve(stage,'manifest.json'),manifest);
  await rename(stage,output);return manifest;
 }finally{await db.end();}
}

function evaluate(candidate,inputs,signals,interval,detail=false){
 const selected=inputs.filter(p=>p.candles.length),step=interval==='30s'?30000:60000;
 const from=Math.min(...selected.map(p=>p.candles[0].time)),to=Math.max(...selected.map(p=>p.candles.at(-1).time))+step;
 return evaluateWindow({...candidate,config:gateConfig(candidate.config,selected,signals)},selected,from,to,{interval,valueType:'mcap',warmupBars:0,detail});
}
export async function studyAllSignals(snapshot,priorRoot,expandedPath,output,{perInterval=128}={}){
 snapshot=resolve(snapshot);output=resolve(output);await mkdir(output,{recursive:true});
 const manifest=await read(resolve(snapshot,'manifest.json')),{checksum,...unsigned}=manifest;
 assert.equal(hash(unsigned),checksum);assert.equal(manifest.engineVersion,ENGINE_VERSION);
 assert.equal(await fileHash(resolve(snapshot,'metadata.json')),manifest.metadataHash);
 const metadata=await read(resolve(snapshot,'metadata.json')),expanded=await read(resolve(expandedPath,'report.json'));
 const report={scope:'Full shared-capital account per chain; all CA with external signals and 30s/1m mcap; strictly after first signal; exploratory, no holdout',snapshotHash:checksum,engineVersion:ENGINE_VERSION,chains:{}};
 for(const chain of CHAINS){
  const byInterval={};for(const interval of INTERVALS)byInterval[interval]=(await loadInputs(snapshot,manifest,chain,interval)).inputs;
  const {signals,excluded}=coveredSignals(metadata.token_signal_events,byInterval,chain),known=new Set(signals.map(caKey));
  assert(signals.length>0);
  const prior=await read(resolve(priorRoot,chain,'protocol.json')),priorReport=await read(resolve(priorRoot,chain,'report.json'));
  const candidates=researchCandidates(prior,priorReport,expanded,chain,perInterval),results=[];
  for(const c of candidates){const inputs=byInterval[c.interval].filter(p=>known.has(caKey(p.symbol)));
   const r=evaluate(c,inputs,signals,c.interval);
   results.push({id:c.id,interval:c.interval,returnPercent:r.accountReturn,netPnl:r.netPnl,trades:r.totalTrades,drawdown:r.accountMaxDrawdown,normalReturn:r.normalReturn,terminalTrades:r.excludedCount,topCa:r.topCaKey,topCaPnl:r.topCaPnl,seconds:r.seconds});
   if(results.length%10===0){await saveJson(resolve(output,`${chain}-partial.json`),{snapshotHash:checksum,done:results.length,total:candidates.length,results});console.log(JSON.stringify({chain,done:results.length,total:candidates.length,best:Math.max(...results.map(x=>x.returnPercent))}));}
   await new Promise(r=>setImmediate(r));
  }
  const leaders=[...results].filter(r=>r.trades>=10&&r.returnPercent>0).sort((a,b)=>b.returnPercent-a.returnPercent||a.drawdown-b.drawdown).slice(0,10);
  const details=[];for(const lead of leaders){const c=candidates.find(x=>x.id===lead.id),inputs=byInterval[c.interval].filter(p=>known.has(caKey(p.symbol)));
   const baseline=evaluate(c,inputs,signals,c.interval,true),stressed=structuredClone(c);stressed.config.executionConfig.slippagePercent+=1;
   const stress=evaluate(stressed,inputs,signals,c.interval),topCa=baseline.topCaKey?.slice(chain.length+1);
   const withoutBest=topCa?evaluate(c,inputs.filter(p=>p.symbol.ca!==topCa),signals,c.interval):null;
   details.push({id:c.id,interval:c.interval,config:c.config,baseline,stress:{returnPercent:stress.accountReturn,trades:stress.totalTrades,drawdown:stress.accountMaxDrawdown},withoutBest:withoutBest&&{ca:topCa,returnPercent:withoutBest.accountReturn,trades:withoutBest.totalTrades,drawdown:withoutBest.accountMaxDrawdown}});
  }
  report.chains[chain]={signalCaCount:earliestSignals(metadata.token_signal_events.filter(e=>e.chain===chain)).length,eligibleCaCount:signals.length,excluded,coverage:Object.fromEntries(INTERVALS.map(i=>[i,{pools:byInterval[i].length,candles:byInterval[i].reduce((n,p)=>n+p.candles.length,0)}])),candidateCount:candidates.length,results,details};
  await saveJson(resolve(output,`${chain}-report.json`),report.chains[chain]);
 }
 report.completedAt=new Date().toISOString();await saveJson(resolve(output,'report.json'),report);return report;
}

export async function refineAllSignals(snapshot,priorRoot,baseReportPath,output){
 snapshot=resolve(snapshot);output=resolve(output);await mkdir(output,{recursive:true});
 const manifest=await read(resolve(snapshot,'manifest.json')),{checksum,...unsigned}=manifest;
 assert.equal(hash(unsigned),checksum);assert.equal(manifest.engineVersion,ENGINE_VERSION);
 const metadata=await read(resolve(snapshot,'metadata.json')),base=await read(resolve(baseReportPath,'report.json'));
 assert.equal(base.snapshotHash,checksum);
 const report={scope:'Bounded full-account exploration: three first-pass leaders per chain × existing signal-wait/reentry settings; no validation split',snapshotHash:checksum,chains:{}};
 for(const chain of CHAINS){
  const byInterval={};for(const interval of INTERVALS)byInterval[interval]=(await loadInputs(snapshot,manifest,chain,interval)).inputs;
  const {signals}=coveredSignals(metadata.token_signal_events,byInterval,chain),known=new Set(signals.map(caKey));
  const prior=await read(resolve(priorRoot,chain,'protocol.json'));
  const candidates=waitingVariants(prior,base.chains[chain].results),results=[];
  for(const c of candidates){const inputs=byInterval[c.interval].filter(p=>known.has(caKey(p.symbol))),r=evaluate(c,inputs,signals,c.interval);
   results.push({id:c.id,baseId:c.id.split('-D')[0],interval:c.interval,delay:c.config.minimumSignalAgeMinutes,reentry:c.config.positionConfig.allowReentry,
    returnPercent:r.accountReturn,netPnl:r.netPnl,trades:r.totalTrades,drawdown:r.accountMaxDrawdown,terminalTrades:r.excludedCount,topCa:r.topCaKey,topCaPnl:r.topCaPnl,seconds:r.seconds});
   if(results.length%5===0){await saveJson(resolve(output,`${chain}-partial.json`),{snapshotHash:checksum,done:results.length,total:candidates.length,results});
    console.log(JSON.stringify({stage:'refine',chain,done:results.length,total:candidates.length,best:Math.max(...results.map(x=>x.returnPercent))}));}
   await new Promise(r=>setImmediate(r));
  }
  const leaders=[...results].filter(r=>r.trades>=10&&r.returnPercent>0).sort((a,b)=>b.returnPercent-a.returnPercent).slice(0,10),details=[];
  for(const lead of leaders){const c=candidates.find(x=>x.id===lead.id),inputs=byInterval[c.interval].filter(p=>known.has(caKey(p.symbol)));
   const baseline=evaluate(c,inputs,signals,c.interval,true),stressed=structuredClone(c);stressed.config.executionConfig.slippagePercent+=1;
   const stress=evaluate(stressed,inputs,signals,c.interval),topCa=baseline.topCaKey?.slice(chain.length+1);
   const withoutBest=topCa?evaluate(c,inputs.filter(p=>p.symbol.ca!==topCa),signals,c.interval):null;
   details.push({id:c.id,config:c.config,baseline,stress:{returnPercent:stress.accountReturn,trades:stress.totalTrades,drawdown:stress.accountMaxDrawdown},
    withoutBest:withoutBest&&{ca:topCa,returnPercent:withoutBest.accountReturn,trades:withoutBest.totalTrades,drawdown:withoutBest.accountMaxDrawdown}});
  }
  report.chains[chain]={candidateCount:candidates.length,results,details};await saveJson(resolve(output,`${chain}-report.json`),report.chains[chain]);
 }
 report.completedAt=new Date().toISOString();await saveJson(resolve(output,'report.json'),report);return report;
}

export async function tuneRobin(snapshot,priorRoot,output){
 snapshot=resolve(snapshot);output=resolve(output);await mkdir(output,{recursive:true});
 const manifest=await read(resolve(snapshot,'manifest.json')),{checksum,...unsigned}=manifest;
 assert.equal(hash(unsigned),checksum);assert.equal(manifest.engineVersion,ENGINE_VERSION);
 const metadata=await read(resolve(snapshot,'metadata.json'));
 const byInterval={};for(const interval of INTERVALS)byInterval[interval]=(await loadInputs(snapshot,manifest,'robin',interval)).inputs;
 const {signals}=coveredSignals(metadata.token_signal_events,byInterval,'robin'),known=new Set(signals.map(caKey));
 const inputs=byInterval['1m'].filter(p=>known.has(caKey(p.symbol)));
 const prior=await read(resolve(priorRoot,'robin','protocol.json')),candidates=robinExitVariants(prior),results=[];
 for(const c of candidates){const r=evaluate(c,inputs,signals,'1m');
  results.push({id:c.id,returnPercent:r.accountReturn,netPnl:r.netPnl,trades:r.totalTrades,drawdown:r.accountMaxDrawdown,
   terminalTrades:r.excludedCount,topCa:r.topCaKey,topCaPnl:r.topCaPnl,seconds:r.seconds});
  if(results.length%5===0){await saveJson(resolve(output,'partial.json'),{snapshotHash:checksum,done:results.length,total:candidates.length,results});
   console.log(JSON.stringify({stage:'robin-tune',done:results.length,total:candidates.length,best:Math.max(...results.map(x=>x.returnPercent))}));}
  await new Promise(r=>setImmediate(r));
 }
 const leaders=[...results].filter(r=>r.trades>=10&&r.returnPercent>0).sort((a,b)=>b.returnPercent-a.returnPercent).slice(0,10),details=[];
 for(const lead of leaders){const c=candidates.find(x=>x.id===lead.id),baseline=evaluate(c,inputs,signals,'1m',true),stressed=structuredClone(c);
  stressed.config.executionConfig.slippagePercent+=1;const stress=evaluate(stressed,inputs,signals,'1m'),topCa=baseline.topCaKey?.slice('robin:'.length);
  const withoutBest=topCa?evaluate(c,inputs.filter(p=>p.symbol.ca!==topCa),signals,'1m'):null;
  details.push({id:c.id,config:c.config,baseline,stress:{returnPercent:stress.accountReturn,trades:stress.totalTrades,drawdown:stress.accountMaxDrawdown},
   withoutBest:withoutBest&&{ca:topCa,returnPercent:withoutBest.accountReturn,trades:withoutBest.totalTrades,drawdown:withoutBest.accountMaxDrawdown}});
 }
 const report={scope:'ROBIN exploratory full-account exit/horizon grid, no validation split',snapshotHash:checksum,candidateCount:candidates.length,results,details,completedAt:new Date().toISOString()};
 await saveJson(resolve(output,'report.json'),report);return report;
}

export async function auditSelectedEntries(snapshot,solReportPath,robinReportPath,output){
 snapshot=resolve(snapshot);output=resolve(output);await mkdir(output,{recursive:true});
 const manifest=await read(resolve(snapshot,'manifest.json')),{checksum,...unsigned}=manifest;
 assert.equal(hash(unsigned),checksum);assert.equal(manifest.engineVersion,ENGINE_VERSION);
 const metadata=await read(resolve(snapshot,'metadata.json'));
 const selected=[{chain:'sol',record:(await read(resolve(solReportPath,'sol-report.json'))).details.find(x=>x.id==='30s-E0312-D120-R0')},
  {chain:'robin',record:(await read(resolve(robinReportPath,'report.json'))).details.find(x=>x.id==='1m-E0005-D60-RR3-H30')}];
 const results=[];for(const {chain,record} of selected){assert(record);
  const interval=chain==='sol'?'30s':'1m',loaded=await loadInputs(snapshot,manifest,chain,interval);
  const signals=earliestSignals(metadata.token_signal_events.filter(e=>e.chain===chain));
  const known=new Set(signals.map(caKey)),inputs=loaded.inputs.filter(p=>known.has(caKey(p.symbol))&&p.candles.length&&p.candles.at(-1).time>signals.find(s=>caKey(s)===caKey(p.symbol)).signalTime);
  const result=evaluate({id:record.id,config:record.config},inputs,signals,interval,true);
  assert(Math.abs(result.accountReturn-record.baseline.accountReturn)<1e-8,'Replay result changed during audit');
  results.push({chain,id:record.id,accountReturn:result.accountReturn,trades:result.totalTrades,syntheticBars:result.syntheticBars,processedBars:result.processedBars,
   entryEvents:result.audit.buyEvents,syntheticEntryEvents:result.audit.syntheticEntryEvents,syntheticEntryTrades:result.audit.syntheticEntryTrades,
   syntheticEntryNetPnl:result.audit.syntheticEntryNetPnl});
 }
 const report={snapshotHash:checksum,results,completedAt:new Date().toISOString()};await saveJson(resolve(output,'report.json'),report);return report;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [mode,a,b,c,d]=process.argv.slice(2);
 if(mode==='export')console.log(JSON.stringify(await exportAllSignals(a,process.env.DATABASE_URL)));
 else if(mode==='study')console.log(JSON.stringify({completedAt:(await studyAllSignals(a,b,c,d,{perInterval:Number(process.env.PER_INTERVAL??128)})).completedAt}));
 else if(mode==='refine')console.log(JSON.stringify({completedAt:(await refineAllSignals(a,b,c,d)).completedAt}));
 else if(mode==='tune-robin')console.log(JSON.stringify({completedAt:(await tuneRobin(a,b,c)).completedAt}));
 else if(mode==='audit-entries')console.log(JSON.stringify(await auditSelectedEntries(a,b,c,d)));
 else throw Error('Usage: all-signal-research.mjs export SNAPSHOT_DIR | study SNAPSHOT_DIR PRIOR_ROOT EXPANDED_REPORT_DIR OUTPUT_DIR | refine SNAPSHOT_DIR PRIOR_ROOT BASE_REPORT_DIR OUTPUT_DIR | tune-robin SNAPSHOT_DIR PRIOR_ROOT OUTPUT_DIR | audit-entries SNAPSHOT_DIR SOL_REPORT_DIR ROBIN_REPORT_DIR OUTPUT_DIR');
}
