/** Explicit --yes writes only token tables. DATABASE_URL must be supplied, never hardcoded. */
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(new URL('../apps/api/package.json',import.meta.url)),{Client}=require('pg');
const [manifestPath,reportPath,...options]=process.argv.slice(2);
assert(manifestPath&&reportPath&&process.env.DATABASE_URL,'Usage: DATABASE_URL=... node scripts/backfill-token-signals.mjs manifest.json report.json [--yes]');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));assert.equal(manifest.version,1);assert(Array.isArray(manifest.events));
const key=r=>JSON.stringify([r.chain,r.ca]);
const db=new Client({connectionString:process.env.DATABASE_URL});await db.connect();
try{
 await db.query(options.includes('--yes')?'BEGIN':'BEGIN READ ONLY');
 if(options.includes('--yes'))await db.query("SELECT pg_advisory_xact_lock(hashtext('token-signal-backfill'))");
 const before=(await db.query('SELECT run_id,md5(report_json::text) AS checksum FROM backtest_reports ORDER BY run_id')).rows;
 const inventory=(await db.query(`SELECT DISTINCT lower(trim(chain)) AS chain,CASE WHEN lower(trim(chain))='robin' THEN lower(trim(ca)) ELSE trim(ca) END AS ca,pair_id AS pair FROM public.meme_kline WHERE chain IS NOT NULL AND ca IS NOT NULL AND pair_id IS NOT NULL AND trim(chain)<>'' AND trim(ca)<>'' AND pair_id<>'' ORDER BY 1,2,3`)).rows;
 const known=new Set(inventory.map(key)),matched=manifest.events.filter(e=>known.has(key(e))),unmatched=manifest.events.filter(e=>!known.has(key(e)));
 const earliest=new Map();for(const e of matched){assert(Number.isSafeInteger(e.signalTime)&&e.signalTime>=0);assert.equal(e.signalSource,'fomo_new_project');const old=earliest.get(key(e));if(!old||e.signalTime<old.signalTime)earliest.set(key(e),e);}
 const report={mode:options.includes('--yes')?'write':'preview',cas:known.size,pools:inventory.length,matchedSignals:matched.length,duplicateFileRows:manifest.duplicates,unmatched:unmatched.map(({chain,ca,detailId})=>({chain,ca,detailId})),missing:[...known].filter(k=>!earliest.has(k)).map(k=>JSON.parse(k)),beforeReports:before};
 if(options.includes('--yes')){
  for(const p of inventory)await db.query(`INSERT INTO token_info(chain,ca,pair,signal_source) VALUES($1,$2,$3,'fomo_new_project') ON CONFLICT(chain,ca,pair) DO NOTHING`,[p.chain,p.ca,p.pair]);
  for(const e of matched){
   const existing=(await db.query('SELECT signal_time::float8 AS time,source_signal FROM token_signal_events WHERE chain=$1 AND ca=$2 AND signal_source=$3 AND detail_id=$4',[e.chain,e.ca,e.signalSource,e.detailId])).rows[0];
   if(existing){assert.equal(existing.time,e.signalTime,'Conflicting signal time');assert.deepEqual(existing.source_signal,e.sourceSignal,'Conflicting signal identity');}
   await db.query(`INSERT INTO token_signal_events(chain,ca,signal_source,detail_id,signal_time,source_signal,provenance) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(chain,ca,signal_source,detail_id) DO UPDATE SET provenance=(SELECT jsonb_agg(DISTINCT p) FROM jsonb_array_elements(token_signal_events.provenance || EXCLUDED.provenance) p)`,[e.chain,e.ca,e.signalSource,e.detailId,e.signalTime,JSON.stringify(e.sourceSignal),JSON.stringify(e.provenance)]);
  }
  await db.query(`WITH first AS (SELECT DISTINCT ON(chain,ca) chain,ca,signal_time,source_signal,signal_source FROM token_signal_events ORDER BY chain,ca,signal_time,detail_id) UPDATE token_info t SET signal_time=f.signal_time,source_signal=f.source_signal,signal_source=f.signal_source FROM first f WHERE t.chain=f.chain AND t.ca=f.ca AND (t.signal_time IS NULL OR f.signal_time<=t.signal_time)`);
  report.after=(await db.query('SELECT count(*)::int AS pools,count(DISTINCT (chain,ca))::int AS cas,count(*) FILTER(WHERE signal_time IS NULL)::int AS missing_pools FROM token_info')).rows[0];
 }
 const after=(await db.query('SELECT run_id,md5(report_json::text) AS checksum FROM backtest_reports ORDER BY run_id')).rows;
 for(const b of before)assert(after.some(a=>a.run_id===b.run_id&&a.checksum===b.checksum),'Historical report changed during backfill');
 await db.query('COMMIT');await writeFile(reportPath,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,beforeReports:undefined,missingCount:report.missing.length,missing:undefined,unmatchedCount:report.unmatched.length,unmatched:undefined}));
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
