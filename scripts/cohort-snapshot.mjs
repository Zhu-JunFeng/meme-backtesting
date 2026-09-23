/** Read-only production export; the research runner only opens these local files. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,writeFile,mkdir,rename,access} from 'node:fs/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ENGINE_VERSION,validCandle} from '../packages/engine/dist/index.js';

export const chains=['sol','robin','bsc'];
export const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export async function saveJson(path,value){await writeFile(path+'.tmp',JSON.stringify(value,null,2));await rename(path+'.tmp',path);}
export async function fileHash(path){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
export function requireFinishedImport(text){const rows=text.trim().split('\n').filter(Boolean).map(JSON.parse);const end=rows.at(-1);assert.equal(end?.kind,'summary','Import not complete: refuse to freeze changing data');return {start:rows.find(r=>r.kind==='start'),summary:end,issues:rows.filter(r=>['lookup_skipped','creation_excluded'].includes(r.kind)||r.kind==='project'&&r.status!=='success')};}
export function importComplete(text){if(!text.trim())return false;try{if(JSON.parse(text.trim().split('\n').at(-1)).kind!=='summary')return false;}catch(e){if(e instanceof SyntaxError)return false;throw e;}requireFinishedImport(text);return true;}
export async function* candleLines(path){const stream=createReadStream(path).pipe(createGunzip());for await(const line of createInterface({input:stream,crlfDelay:Infinity}))if(line)yield JSON.parse(line);}
export function decodeRow(chain,r){const [ca,pairId,time,closeTime,open,high,low,close,volume,valid]=r;return {symbol:{chain,ca,pairId},candle:{time,closeTime,open,high,low,close,volume,valid}};}

export async function snapshot({connectionString,output,importReport,client,allKlines=false}){
 assert(connectionString||client);output=resolve(output);
 const audit=importReport?requireFinishedImport(await readFile(importReport,'utf8')):{source:'direct_read_only_database_snapshot'};
 await mkdir(output,{recursive:true});
 try{await access(resolve(output,'manifest.json'));throw Error('Snapshot already exists; do not overwrite');}catch(e){if(e.code!=='ENOENT')throw e;}
 const require=createRequire(new URL('../apps/api/package.json',import.meta.url)),{Client}=require('pg');
 const db=client??new Client({connectionString,application_name:'cohort-readonly-export'});
 const manifest={version:1,engineVersion:ENGINE_VERSION,startedAt:new Date().toISOString(),importAudit:audit,files:[]};
 try{
  await db.connect();await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  manifest.snapshot=(await db.query('SELECT txid_current_snapshot()::text AS snapshot')).rows[0].snapshot;
  const metadata={};
  for(const table of ['token_info','token_signal_events'])metadata[table]=(await db.query(`SELECT * FROM public.${table} ${allKlines?'':'WHERE chain=ANY($1)'} ORDER BY chain,ca,id`,allKlines?[]:[chains])).rows;
  metadata.versions=(await db.query('SELECT t.name,t.status,v.* FROM backtest_strategy_versions v JOIN backtest_strategy_templates t ON t.id=v.template_id ORDER BY v.created_at,v.id')).rows;
  metadata.previousRuns=allKlines?[]:(await db.query("SELECT r.id,r.name,r.config_json,p.report_json FROM backtest_runs r JOIN backtest_reports p ON p.run_id=r.id WHERE r.status='completed' ORDER BY r.id")).rows;
  await saveJson(resolve(output,'metadata.json'),metadata);manifest.metadataHash=await fileHash(resolve(output,'metadata.json'));
  const dimensions=allKlines?(await db.query('SELECT DISTINCT chain,interval,type FROM public.meme_kline ORDER BY chain,interval,type')).rows:chains.flatMap(chain=>['30s','1m'].flatMap(interval=>['mcap','price'].map(type=>({chain,interval,type}))));
  for(const {chain,interval,type} of dimensions){
   const name=`${chain}-${interval}-${type}.jsonl.gz`,path=resolve(output,name),gzip=createGzip(),sink=createWriteStream(path+'.tmp',{flags:'wx'});
   const completion=finished(sink);gzip.on('error',e=>sink.destroy(e));gzip.pipe(sink);
   let rows=0,valid=0,firstTime=Infinity,lastTime=-Infinity;const digest=createHash('sha256');
   await db.query('DECLARE export_rows NO SCROLL CURSOR FOR SELECT ca,pair_id,open_time::float8,close_time::float8,open::float8,high::float8,low::float8,close::float8,volume::float8,valid FROM meme_kline WHERE chain=$1 AND interval=$2 AND type=$3 ORDER BY ca,pair_id,open_time',[chain,interval,type]);
   try{for(;;){const batch=await db.query('FETCH 10000 FROM export_rows');if(!batch.rowCount)break;
    for(const r of batch.rows){const a=[r.ca,r.pair_id,r.open_time,r.close_time,r.open,r.high,r.low,r.close,r.volume,r.valid];const line=JSON.stringify(a)+'\n';digest.update(line);rows++;firstTime=Math.min(firstTime,Number(r.open_time));lastTime=Math.max(lastTime,Number(r.open_time));if(validCandle(decodeRow(chain,a).candle))valid++;if(!gzip.write(line))await once(gzip,'drain');}
   }gzip.end();await completion;await rename(path+'.tmp',path);}catch(e){gzip.destroy();sink.destroy();await completion.catch(()=>{});throw e;}
   await db.query('CLOSE export_rows');manifest.files.push({chain,interval,type,name,rows,valid,firstTime:rows?firstTime:null,lastTime:rows?lastTime:null,sha256:await fileHash(path),dataHash:digest.digest('hex')});
   console.log(JSON.stringify({stage:'snapshot',...manifest.files.at(-1)}));
  }
  await db.query('COMMIT');manifest.completedAt=new Date().toISOString();manifest.checksum=hash(manifest);await saveJson(resolve(output,'manifest.json'),manifest);
 }finally{await db.end();}
 return manifest;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const [output,importReport,...flags]=process.argv.slice(2);assert(output,'Usage: cohort-snapshot.mjs OUTPUT [IMPORT_REPORT] [--all-klines]; DATABASE_URL required');await snapshot({connectionString:process.env.DATABASE_URL,output,importReport:importReport?.startsWith('--')?undefined:importReport,allKlines:importReport==='--all-klines'||flags.includes('--all-klines')});}
