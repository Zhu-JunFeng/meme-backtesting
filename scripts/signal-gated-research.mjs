/** Local-only research; never submits tasks or changes production strategies. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {assertLocalDatabase,evaluateWindow} from './offline-strategy-research.mjs';
import {candidatesAround} from './explore-strategy-neighborhood.mjs';
import {validCandle,poolKey,ENGINE_VERSION} from '../packages/engine/dist/index.js';

export function gateConfig(config,inputs,signals){
 const c=structuredClone(config),keys=new Set(inputs.map(p=>JSON.stringify([p.symbol.chain,p.symbol.ca])));
 c.symbols=inputs.map(p=>p.symbol);
 c.entrySignals=signals.filter(s=>keys.has(JSON.stringify([s.chain,s.ca]))).map(({chain,ca,signalTime})=>({chain,ca,signalTime}));
 assert.equal(new Set(c.entrySignals.map(s=>JSON.stringify([s.chain,s.ca]))).size,keys.size,'Missing monitoring signal');
 c.exitConfig.closeAtEnd=true;
 return c;
}

export function splitSignals(signals){
 const times=[...new Set(signals.map(s=>s.signalTime))].sort((a,b)=>a-b);
 assert(times.length>=2);
 const cutoff=times[Math.min(times.length-1,Math.floor(times.length*.7))];
 return {cutoff,training:signals.filter(s=>s.signalTime<cutoff),validation:signals.filter(s=>s.signalTime>=cutoff)};
}

export async function research(chain,output,count=160){
 assert(['sol','robin'].includes(chain));
 const read=async p=>JSON.parse(await readFile(p,'utf8'));
 const manifest=await read('output/local-market-data/manifest.json');assert(manifest.verifiedAt);assertLocalDatabase(manifest.local);
 const signals=(await read('output/signal-gated-20260922/manifest.json')).entries;
 const ids=chain==='sol'?['E0022','E0029']:['E0010','E0037'];
 const bases=await Promise.all(ids.map(async id=>(await read(`output/research-stable5-20260921/terminal-close/replay-audit/${chain}-${id}-source.json`)).run.config_json));
 const known=new Set(signals.filter(s=>s.chain===chain).map(s=>s.ca));
 const missing=bases[0].symbols.filter(s=>!known.has(s.ca));
 const selected=bases[0].symbols.filter(s=>known.has(s.ca));
 const snapshots=new Map(bases[0].pools.map(p=>[poolKey(p),p]));
 const pools=new Map(selected.map(symbol=>[poolKey(symbol),{symbol,candles:[]} ]));
 const require=createRequire(new URL('../apps/api/package.json',import.meta.url)),{Client}=require('pg');
 const db=new Client({...manifest.local,application_name:'signal-gated-local-research'});
 try{
  await db.connect();await db.query('BEGIN READ ONLY');
  const rows=(await db.query('SELECT ca,pair_id,open_time::float8 AS time,close_time::float8 AS "closeTime",open::float8,high::float8,low::float8,close::float8,volume::float8 FROM public.meme_kline WHERE chain=$1 AND interval=$2 AND type=$3 AND valid IS NOT FALSE ORDER BY ca,pair_id,open_time',[chain,'30s','mcap'])).rows;
  for(const {ca,pair_id,...candle} of rows){const k=poolKey({chain,ca,pairId:pair_id}),p=pools.get(k),snap=snapshots.get(k);if(p&&candle.time>=snap.startTime&&candle.time<=snap.endTime&&validCandle(candle))p.candles.push({...candle,valid:true});}
  await db.query('COMMIT');
 }finally{await db.end();}
 const inputs=[...pools.values()],from=Math.min(...inputs.filter(p=>p.candles.length).map(p=>p.candles[0].time)),to=Math.max(...inputs.filter(p=>p.candles.length).map(p=>p.candles.at(-1).time))+30000;
 const applicable=gateConfig(bases[0],inputs,signals).entrySignals,split=splitSignals(applicable);
 const cohort=ss=>{const cas=new Set(ss.map(s=>s.ca));return inputs.filter(p=>cas.has(p.symbol.ca));};
 const train=cohort(split.training),validation=cohort(split.validation);
 const candidates=candidatesAround(bases,count,20260925);
 await mkdir(output,{recursive:true});
 const save=(name,value)=>writeFile(resolve(output,name+'.json'),JSON.stringify(value,null,2));
 const dataHash=createHash('sha256');for(const p of inputs)dataHash.update(JSON.stringify(p));
 await writeFile(resolve(output,'protocol.json'),JSON.stringify({chain,engineVersion:ENGINE_VERSION,dataHash:dataHash.digest('hex'),missing,from,to,cutoff:split.cutoff,trainingCas:split.training.length,validationCas:split.validation.length,candidates,rule:'Strict entry after external signal. Preserve all available pre-signal indicator history. Close at last candle. Original costs unchanged.',selection:'Rank training returns with >=10 trades and <=20% drawdown; freeze top 10 before later-cohort evaluation. Cohorts are disjoint by CA discovery time; training ends at cutoff. Previously inspected historical data, NOT fresh blind validation. No claim of stable 5%.'},null,2),{flag:'wx'});
 const log=x=>console.log(JSON.stringify({chain,...x}));
 const run=(candidate,ps,end=to)=>evaluateWindow({...candidate,config:gateConfig(candidate.config,ps,applicable)},ps,from,end,{warmupBars:0});
 const baseline=[];
 for(let i=0;i<bases.length;i++){const r=run({id:ids[i],config:bases[i]},inputs);baseline.push(r);log({stage:'baseline',...r});}
 await save('baseline',baseline);
 if(chain==='sol')for(let i=0;i<2;i++)assert(Math.abs(baseline[i].accountReturn-[-9.938610427608516,-13.759347540397105][i])<1e-7,'Local replay differs from production; abort search');
 const training=[];
 for(const c of candidates){const r=run(c,train,split.cutoff);training.push(r);await save('training',training);if(training.length%5===0)log({stage:'training',done:training.length,total:count,best:Math.max(...training.map(t=>t.accountReturn))});await new Promise(r=>setImmediate(r));}
 const shortlist=training.filter(r=>r.totalTrades>=10&&r.accountMaxDrawdown<=20).sort((a,b)=>b.accountReturn-a.accountReturn).slice(0,10);
 await save('shortlist',shortlist);
 const results=[];
 for(const r of shortlist){const c=candidates.find(c=>c.id===r.id),v=run(c,validation),full=run(c,inputs);results.push({id:c.id,training:r,validation:v,full,config:c.config});await save('results',results);log({stage:'validation',id:c.id,train:r.accountReturn,validation:v.accountReturn,full:full.accountReturn});await new Promise(r=>setImmediate(r));}
 log({stage:'complete',positiveBoth:results.filter(r=>r.training.accountReturn>0&&r.validation.accountReturn>0).length});
 return results;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const [chain,output,count='160']=process.argv.slice(2);await research(chain,resolve(output),Number(count));}
