/** Explicitly authorized new-task replay. Never edits an existing historical run. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {poolKey,ENGINE_VERSION} from '../packages/engine/dist/index.js';
import {hash,saveJson,fileHash} from './cohort-snapshot.mjs';
import {loadInputs,earliestSignals,stability} from './cohort-research.mjs';
import {gateConfig} from './signal-gated-research.mjs';
import {ledgerHash} from './offline-strategy-research.mjs';
const key=s=>JSON.stringify([s.chain,s.ca]);
export function deterministicId(value){const h=hash(value).slice(0,32);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
export function tradeFromRow(t){const r={symbol:{chain:t.chain,ca:t.ca,pairId:t.pair_id},adds:t.adds_json};for(const [a,b] of Object.entries({entryTime:'entry_time',entryPrice:'entry_price',quantity:'quantity',exitTime:'exit_time',exitPrice:'exit_price',grossPnl:'gross_pnl',fees:'fees',slippageCost:'slippage_cost',taxCost:'tax_cost',netPnl:'net_pnl',holdingBars:'holding_bars',tradeNo:'trade_no',firstEntryPrice:'first_entry_price',buyAmount:'buy_amount',buyFees:'buy_fees',buySlippageCost:'buy_slippage_cost',buyTaxCost:'buy_tax_cost'}))if(t[b]!=null)r[a]=Number(t[b]);r.exitReason=t.exit_reason;return r;}
export function signalFromRow(s){const r={symbol:{chain:s.chain,ca:s.ca,pairId:s.pair_id},time:Number(s.time),price:Number(s.price),type:s.signal_type,reason:s.reason_json};for(const [a,b] of [['quantity','quantity'],['tradeNo','trade_no'],['eventOrder','event_order']])if(s[b]!=null)r[a]=Number(s[b]);return r;}
export function compareResult(expected,report,trades,signals){
 assert.equal(report.engineVersion,ENGINE_VERSION,'Server engine version differs');
 for(const [a,b] of [['accountReturn','returnPercent'],['accountMaxDrawdown','maxDrawdownPercent'],['netPnl','netPnl']])assert(Math.abs(expected[a]-report[b])<=1e-7,`${a} differs`);
 assert.equal(expected.totalTrades,report.totalTrades);assert.equal(ledgerHash(trades),expected.audit.tradeHash,'trade events differ');assert.equal(ledgerHash(signals),expected.audit.signalHash,'signal events differ');
}
export async function serverVerify({snapshot,study,output,api,connectionString,submit=false,queueScope='meme-production-v3'}){
 const read=async p=>JSON.parse(await readFile(p,'utf8'));
 const report=await read(resolve(study,'report.json')),protocol=await read(resolve(study,'protocol.json')),manifest=await read(resolve(snapshot,'manifest.json'));
 assert.equal(report.protocolHash,hash(protocol));assert.equal(report.snapshotHash,manifest.checksum);assert.equal(manifest.engineVersion,ENGINE_VERSION);
 assert.equal(await fileHash(resolve(snapshot,'metadata.json')),manifest.metadataHash);const metadata=await read(resolve(snapshot,'metadata.json'));
 const candidates=report.uploadCandidates.map(id=>report.results.find(r=>r.id===id));assert(candidates.length<=3);
 for(const c of candidates){assert(c?.pass&&!c.costSensitive&&c.stress?.assessment.pass);assert(stability([...c.development.slice(1),...c.validation],c.combined).pass);}
 if(!candidates.length)return {chain:report.chain,submitted:[],reason:'No qualifying strategies; no server writes'};
 if(!submit)return {chain:report.chain,candidates:candidates.map(c=>c.id),submit:false};
 assert(connectionString&&api);await mkdir(output,{recursive:true});
 async function request(path,body){const r=await fetch(api.replace(/\/$/,'')+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error(`${path}: ${r.status}`);return r.json();}
 const require=createRequire(new URL('../apps/api/package.json',import.meta.url)),{Client}=require('pg'),db=new Client({connectionString,application_name:'cohort-frozen-replay'});
 const verified=[];await db.connect();
 const stagingScope=`${queueScope}-research-staging-${report.protocolHash.slice(0,8)}`;
 try{for(const candidate of candidates){
  const name=`日期分组稳健 · ${report.chain.toUpperCase()} · ${candidate.id} · ${report.snapshotHash.slice(0,8)}`;
  const matches=(await request('/strategy-templates')).filter(t=>t.name===name);assert(matches.length<=1);
  const template=matches.length?await request(`/strategy-templates/${matches[0].id}`):await request('/strategy-templates',{name,description:report.scope,status:'active',strategyJson:candidate.config});
  assert.deepEqual(template.strategyJson,candidate.config,'Existing template differs');
  const version=await request(`/strategy-versions/${template.currentVersionId}`);
  const {inputs}=await loadInputs(snapshot,manifest,report.chain,candidate.interval),signals=earliestSignals(metadata.token_info.filter(t=>t.chain===report.chain));
  for(const folds of [[1],[2],[3],[4],[5],[1,2,3,4,5]]){
   const expected=candidate.combinations.find(r=>JSON.stringify(r.foldIds)===JSON.stringify(folds));assert(expected);
   const refs=new Set(protocol.partition.entries.filter(e=>folds.includes(e.fold)).map(key));
   const selected=inputs.filter(p=>refs.has(key(p.symbol))&&p.candles.length);
   const symbols=selected.map(p=>p.symbol),step=candidate.interval==='30s'?30000:60000;
   const from=Math.min(...selected.map(p=>p.candles[0].time)),to=Math.max(...selected.map(p=>p.candles.at(-1).time));
   const pools=selected.map(p=>({...p.symbol,startTime:p.candles[0].time,endTime:p.candles.at(-1).time,noData:false}));
   const runName=`${name} · D${folds.join('+')}`;
   const id=deterministicId({study:report.protocolHash,candidate:candidate.id,folds});
   const dataset={symbols,pools,interval:candidate.interval,valueType:'mcap',startTime:new Date(from).toISOString(),endTime:new Date(to).toISOString(),
    externalSignals:metadata.token_signal_events.filter(s=>refs.has(key(s))).map(s=>({chain:s.chain,ca:s.ca,id:s.id,detailId:s.detail_id,signalSource:s.signal_source,signalTime:Number(s.signal_time),sourceSignal:s.source_signal,provenance:s.provenance,basis:'snapshot'})),
    selection:{symbols,interval:candidate.interval,valueType:'mcap',filters:{research:{protocolHash:report.protocolHash,snapshotHash:manifest.checksum,folds}}},signalSelection:{enabled:true,excluded:[],noOpportunity:pools.filter(p=>p.endTime<=signals.find(s=>key(s)===key(p)).signalTime).map(({chain,ca,pairId})=>({chain,ca,pairId}))}};
   const config={...gateConfig(candidate.config,selected,signals),...dataset,name:runName,strategyTemplateId:template.id,strategyVersionId:template.currentVersionId};
   const inputHash=ledgerHash(selected);
   await db.query('BEGIN');
   try{
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
    const old=(await db.query('SELECT * FROM backtest_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];
    if(old)assert.deepEqual(old.config_json,config,'Existing run differs; never overwrite');
    else await db.query("INSERT INTO backtest_runs(id,name,status,config_json,strategy_template_id,strategy_version_id,dataset_json,runtime_version,queue_scope,phase,strategy_description_json) VALUES($1,$2,'stopped',$3,$4,$5,$6,'checkpoint-1',$7,'freezing',$8)",[id,runName,JSON.stringify(config),template.id,template.currentVersionId,JSON.stringify(dataset),stagingScope,JSON.stringify(version.versionDescription??null)]);
    await db.query('COMMIT');
   }catch(e){await db.query('ROLLBACK');throw e;}
   let state=(await db.query('SELECT * FROM backtest_runs WHERE id=$1',[id])).rows[0];
   if(!state.input_ready){
    assert.equal(state.status,'stopped');assert.equal(state.execution_epoch,0);assert.equal(state.queue_scope,stagingScope);
    for(const p of selected){
     if((await db.query('SELECT 1 FROM backtest_input_pools WHERE run_id=$1 AND pool_key=$2',[id,poolKey(p.symbol)])).rowCount)continue;
     await db.query('BEGIN');try{
      const guard=(await db.query('SELECT status,input_ready,execution_epoch FROM backtest_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];assert.equal(guard.status,'stopped');assert.equal(guard.input_ready,false);assert.equal(guard.execution_epoch,0);
      let normalized=0;for(let i=0;i<p.candles.length;i++)normalized+=i?Math.max(1,Math.ceil((p.candles[i].time-p.candles[i-1].time)/step)):1;
      const chunks=[];for(let i=0;i<p.candles.length;i+=256)chunks.push(p.candles.slice(i,i+256));
      for(let i=0;i<chunks.length;i+=64){const batch=chunks.slice(i,i+64),values=batch.flatMap((c,j)=>[id,poolKey(p.symbol),i+j,JSON.stringify(c)]);await db.query(`INSERT INTO backtest_input_chunks(run_id,pool_key,chunk_no,candles_json) VALUES ${batch.map((_,j)=>`($${j*4+1},$${j*4+2},$${j*4+3},$${j*4+4})`).join(',')}`,values);}
      await db.query('INSERT INTO backtest_input_pools VALUES($1,$2,$3,$4,$5,$6,0)',[id,poolKey(p.symbol),JSON.stringify(p.symbol),chunks.length,p.candles.length,normalized]);await db.query('COMMIT');
     }catch(e){await db.query('ROLLBACK');throw e;}
    }
    // Read back exact frozen input before releasing this newly created task to the queue.
    const frozen=[];for(const p of selected){const rows=(await db.query('SELECT candles_json FROM backtest_input_chunks WHERE run_id=$1 AND pool_key=$2 ORDER BY chunk_no',[id,poolKey(p.symbol)])).rows;frozen.push({symbol:p.symbol,candles:rows.flatMap(r=>r.candles_json)});}
    assert.equal(ledgerHash(frozen),inputHash,'Frozen input differs');
    const released=await db.query("UPDATE backtest_runs SET input_ready=true,phase='computing',queue_scope=$2 WHERE id=$1 AND status='stopped' AND execution_epoch=0 AND queue_scope=$3 RETURNING id",[id,queueScope,stagingScope]);assert.equal(released.rowCount,1);
   }
   state=(await db.query('SELECT status FROM backtest_runs WHERE id=$1',[id])).rows[0];
   if(state.status==='stopped')await request(`/backtests/${id}/retry`,{});
   for(;;){const r=(await db.query('SELECT status,error_message FROM backtest_runs WHERE id=$1',[id])).rows[0];if(r.status==='completed')break;if(['failed','cancelled','stopped'].includes(r.status))throw Error(`Server replay ${id}: ${r.status}: ${r.error_message}`);await new Promise(r=>setTimeout(r,15000));}
   const actual=(await db.query('SELECT report_json FROM backtest_reports WHERE run_id=$1',[id])).rows[0].report_json;
   const trades=(await db.query('SELECT * FROM backtest_trades WHERE run_id=$1',[id])).rows.map(tradeFromRow),events=(await db.query('SELECT * FROM backtest_signals WHERE run_id=$1',[id])).rows.map(signalFromRow);
   compareResult(expected,actual,trades,events);
   verified.push({id,name:runName,candidate:candidate.id,folds,inputHash,verified:true,report:actual});await saveJson(resolve(output,'server-verified.json'),verified);
   console.log(JSON.stringify({stage:'server_verified',id,name:runName}));
  }
 }}finally{await db.end();}
 return verified;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const [snapshot,study,output,api,...flags]=process.argv.slice(2);console.log(await serverVerify({snapshot,study,output,api,connectionString:process.env.DATABASE_URL,submit:flags.includes('--submit')}));}
