/** Read-only local cost sensitivity for an already frozen research shortlist. */
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {assertLocalDatabase,evaluateWindow} from './offline-strategy-research.mjs';
import {gateConfig} from './signal-gated-research.mjs';
import {poolKey,validCandle} from '../packages/engine/dist/index.js';
const dir=resolve(process.argv[2]);
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const protocol=await read(resolve(dir,'protocol.json')),results=await read(resolve(dir,'results.json'));
const dataset=protocol.sourceProtocol?.dataset;assert(dataset,'Requires database-preview research protocol');
const manifest=await read('output/local-market-data/manifest.json');assert(manifest.verifiedAt);assertLocalDatabase(manifest.local);
const {Client}=createRequire(new URL('../apps/api/package.json',import.meta.url))('pg');
const db=new Client({...manifest.local,application_name:'signal-candidate-cost-stress'});
const pools=new Map(dataset.pools.map(s=>[poolKey(s),{symbol:{chain:s.chain,ca:s.ca,pairId:s.pairId},snapshot:s,candles:[]}]));
try{await db.connect();await db.query('BEGIN READ ONLY');
 const rows=(await db.query('SELECT ca,pair_id,open_time::float8 AS time,close_time::float8 AS "closeTime",open::float8,high::float8,low::float8,close::float8,volume::float8 FROM meme_kline WHERE chain=$1 AND interval=$2 AND type=$3 AND valid IS NOT FALSE ORDER BY ca,pair_id,open_time',[protocol.chain,'30s','mcap'])).rows;
 for(const {ca,pair_id,...c} of rows){const p=pools.get(poolKey({chain:protocol.chain,ca,pairId:pair_id}));if(p&&c.time>=p.snapshot.startTime&&c.time<=p.snapshot.endTime&&validCandle(c))p.candles.push({...c,valid:true});}
 await db.query('COMMIT');
}finally{await db.end();}
const inputs=[...pools.values()],validation=inputs.filter(p=>dataset.entrySignals.some(s=>s.chain===p.symbol.chain&&s.ca===p.symbol.ca&&s.signalTime>=protocol.cutoff));
const selected=results.filter(r=>r.training.accountReturn>0&&r.validation.accountReturn>0&&r.full.accountReturn>0).sort((a,b)=>b.full.accountReturn-a.full.accountReturn).slice(0,3),stress=[];
for(const r of selected){const c=structuredClone(r.config);c.executionConfig.slippagePercent+=1;
 const run=ps=>evaluateWindow({id:r.id,config:gateConfig(c,ps,dataset.entrySignals)},ps,protocol.from,protocol.to,{warmupBars:0});
 const item={id:r.id,variant:'slippage_plus_1_percentage_point',full:run(inputs),validation:run(validation)};stress.push(item);console.log(JSON.stringify(item));
}
await writeFile(resolve(dir,'cost-stress.json'),JSON.stringify(stress,null,2),{flag:'wx'});
