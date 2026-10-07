/** Explicit audit: snapshot paper evidence, append valid missing history, replay locally.
 * DATABASE_URL=... node scripts/paper-history-comparison.mjs OUTPUT [--append]
 * Default is read-only; --append is solely an insert-missing-candles operation.
 * Replays are diagnostic, not a reproduction of live readiness/admission/eviction.
 * Never changes live state, existing candles, strategies or historical backtests.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ResumableEngine,ENGINE_VERSION} from '../packages/engine/dist/index.js';
const require=createRequire(new URL('../apps/worker/package.json',import.meta.url));
const {Client}=require('pg'),{Decimal}=require('decimal.js');
const fields=['open','high','low','close','volume'];
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const save=async(p,x)=>writeFile(p,JSON.stringify(x,null,2));
const zip=async(p,x)=>writeFile(p,gzipSync(JSON.stringify(x)));
const unzip=async p=>JSON.parse(gunzipSync(await readFile(p)).toString());
const log=x=>console.log(JSON.stringify(x));

export function inspectHistory(body,request){
 assert(body?.success===true&&body.code==='200','历史业务响应失败');
 const d=body.data;
 assert(d?.chain===request.chain&&d.pair_address===request.pairId&&d.interval===request.interval&&d.value_type===(request.type==='mcap'?'market_cap':'price')&&Array.isArray(d.items),'历史响应维度不匹配');
 const step=request.interval==='30s'?30000:60000,valid=[],invalid=[],times=new Map(),conflicts=new Set();let outside=0,duplicates=0;
 for(const r of d.items){
  const time=r.start_time;
  if(!Number.isSafeInteger(time)||time<=0||time%step){invalid.push({time,reason:'invalid_time',raw:r});continue;}
  if(time<request.from||time+step>request.to){outside++;continue;}
  let reason=null;
  try{
   const v=fields.map(k=>{assert(typeof r[k]==='string'&&r[k].length<=512&&/^\d+(\.\d+)?$/.test(r[k]));const n=new Decimal(r[k]);assert(n.isFinite()&&Number.isFinite(n.toNumber()));return n;});
   if(v.slice(0,4).some(n=>n.lte(0)||n.toNumber()<=0)||v[4].lt(0))reason='invalid_value';
   else if(v[1].lt(Decimal.max(v[0],v[3]))||v[2].gt(Decimal.min(v[0],v[3]))||v[1].lt(v[2]))reason='invalid_ohlc';
  }catch{reason='invalid_decimal';}
  const previous=times.get(time);
  if(previous){duplicates++;if(fields.some(k=>previous[k]!==r[k])){conflicts.add(time);invalid.push({time,reason:'conflicting_timestamp',raw:r});}}
  else times.set(time,r);
  if(reason){conflicts.add(time);invalid.push({time,reason,raw:r});}
 }
 for(const [time,r] of times)if(!conflicts.has(time))valid.push({time,closeTime:time+step,...Object.fromEntries(fields.map(k=>[k,r[k]])),valid:true});
 return {valid:valid.sort((a,b)=>a.time-b.time),invalid,outside,duplicates,traceId:body.traceId};
}

export function compareCandles(history,stored){
 const h=new Map(history.map(c=>[Number(c.time),c]));
 const ws=stored.filter(c=>c.source==='meme_market_v2');
 const stats={history:history.length,ws:ws.length,overlap:0,wsOnly:0,historyOnly:0,syntheticOverlap:0,realOverlap:0,allOhlcvEqual:0,fields:Object.fromEntries(fields.map(k=>[k,{different:0,maxPercent:0,sumPercent:0}]))},examples=[];
 for(const c of ws){const r=h.get(Number(c.time));if(!r){stats.wsOnly++;continue;}stats.overlap++;
  if(c.synthetic)stats.syntheticOverlap++;else stats.realOverlap++;
  let same=true;const delta={};
  for(const k of fields){const a=new Decimal(c[k]),b=new Decimal(r[k]),n=a.minus(b).abs(),percent=b.isZero()?null:n.div(b.abs()).mul(100).toNumber();
   // Tolerance is exclusively a comparison classification, never a change to data.
   if(n.gt(Decimal.max(a.abs(),b.abs()).mul('0.00000001'))){same=false;stats.fields[k].different++;if(percent!==null){stats.fields[k].maxPercent=Math.max(stats.fields[k].maxPercent,percent);stats.fields[k].sumPercent+=percent;}delta[k]={ws:String(c[k]),history:String(r[k]),percent};}
  }
  if(same)stats.allOhlcvEqual++;else if(examples.length<20)examples.push({time:Number(c.time),synthetic:!!c.synthetic,delta});
 }
 const w=new Set(ws.map(c=>Number(c.time)));stats.historyOnly=history.filter(c=>!w.has(c.time)).length;
 return {...stats,examples};
}

/** Same chronological, shared-capital engine as worker; gaps retain existing semantics. */
export function replay(config,inputs){
 const c=structuredClone(config);c.symbols=inputs.map(p=>p.symbol);
 const engine=new ResumableEngine(c),step=c.interval==='30s'?30000:60000;
 const readers=inputs.map(p=>({p,index:0,previous:null})),trades=[],signals=[];let synthetic=0;
 const peek=r=>{const raw=r.p.candles[r.index];if(!raw)return null;
  if(r.previous&&r.previous.time+step<raw.time){const time=r.previous.time+step,v=r.previous.close;return {candle:{time,closeTime:time+step,open:v,high:v,low:v,close:v,volume:0,synthetic:true,valid:true},generated:true,last:false};}
  return {candle:raw,generated:false,last:r.index===r.p.candles.length-1};};
 const drain=()=>{const b=engine.drain();trades.push(...b.trades);signals.push(...b.signals);};
 let heads=readers.map(peek);
 for(;;){const time=Math.min(...heads.filter(Boolean).map(h=>h.candle.time));if(!Number.isFinite(time))break;
  const indices=heads.flatMap((h,i)=>h?.candle.time===time?[i]:[]);
  engine.step(indices.map(i=>({symbol:readers[i].p.symbol,candle:heads[i].candle,last:heads[i].last})));
  for(const i of indices){const h=heads[i],r=readers[i];r.previous=h.candle;if(h.generated)synthetic++;else r.index++;heads[i]=peek(r);}
  if(engine.bufferedRows>2000)drain();
 }
 drain();const report=engine.finish();drain();
 const end=trades.filter(t=>t.exitReason==='end_of_backtest');
 return {report,trades,signals,engineVersion:ENGINE_VERSION,generatedGapBars:synthetic,endCount:end.length,endNet:end.reduce((n,t)=>n+t.netPnl,0),normalNet:trades.filter(t=>t.exitReason!=='end_of_backtest').reduce((n,t)=>n+t.netPnl,0)};
}

async function requestHistory(endpoint,req){
 for(let i=0;;i++){
  try{const step=req.interval==='30s'?30000:60000,r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chain:req.chain,pair_address:req.pairId,interval:req.interval,value_type:req.type==='mcap'?'market_cap':'price',from_time:req.from,to_time:req.to,count_back:(req.to-req.from)/step}),signal:AbortSignal.timeout(30000)});
   const body=await r.json();if(!r.ok){const e=new Error(`HTTP ${r.status}: ${body.message}; ${body.traceId??''}`);e.retry=r.status===429||r.status>=500;throw e;}return body;
  }catch(e){if(i>=2||e.retry===false)throw e;await new Promise(r=>setTimeout(r,i?3000:1000));}
 }
}

export async function audit({connectionString,output,append=false,endpoint='https://app.memeinfo.net/api/project-overview/xxyy-klines'}){
 output=resolve(output);await mkdir(output,{recursive:true});
 const db=new Client({connectionString,application_name:'paper-history-comparison',connectionTimeoutMillis:15000});await db.connect();
 try{
  // Fresh directory required: a later audit must not overwrite its earlier frozen evidence.
  const cutoff=Math.floor(Date.now()/60000)*60000;
  const existing=await readFile(`${output}/evidence.json`).catch(e=>{if(e.code!=='ENOENT')throw e;return null;});assert(!existing,'审计目录已存在，请使用新的目录');
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await db.query("SET LOCAL statement_timeout='90s'");
  const runs=(await db.query("SELECT * FROM live_runs WHERE mode='paper' AND status='running' ORDER BY id")).rows;
  const ids=runs.map(r=>r.id);
  const watches=(await db.query('SELECT * FROM live_watches WHERE run_id=ANY($1::uuid[]) ORDER BY run_id,chain,ca',[ids])).rows;
  const events=(await db.query("SELECT * FROM live_events WHERE run_id=ANY($1::uuid[]) AND kind IN ('external_signal','watch_evicted','execution_switched','market_switched') AND event_time<=$2 ORDER BY event_time,id",[ids,cutoff])).rows;
  const orders=(await db.query('SELECT o.*,f.fill_time,f.fill_value,f.fill_price,f.quantity,f.gross_amount,f.fee,f.slippage_cost,f.tax_cost FROM live_orders o LEFT JOIN live_fills f ON f.order_id=o.id WHERE o.run_id=ANY($1::uuid[]) AND o.decision_time<=$2 ORDER BY o.id',[ids,cutoff])).rows;
  // Do not retain arbitrary third-party response payloads or masked live credentials.
  for(const o of orders)delete o.raw_result;
  const jobs=new Map();
  for(const w of watches){const run=runs.find(r=>r.id===w.run_id);if(!w.pair_id||Number(w.signal_time)>cutoff)continue;
   const step=run.interval==='30s'?30000:60000;
   // The historical replay is diagnostic: preserve all received/admitted CAs, including evicted.
   const from=Math.max(step,Math.floor(Number(w.signal_time)/step)*step-1500*step);
   for(const type of ['price','mcap']){const j={chain:w.chain,ca:w.ca,pairId:w.pair_id,interval:run.interval,type,from,to:cutoff};const k=JSON.stringify([j.chain,j.ca,j.pairId,j.interval,type]);if(!jobs.has(k))jobs.set(k,j);else jobs.get(k).from=Math.min(jobs.get(k).from,from);}
  }
  let index=0;
  for(const job of jobs.values()){
   job.index=index++;
   const rows=(await db.query('SELECT open_time AS time,close_time AS "closeTime",open,high,low,close,volume,valid,source,raw_data FROM meme_kline WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND open_time>=$6 AND open_time<$7 ORDER BY open_time',[job.chain,job.ca,job.pairId,job.interval,job.type,job.from,job.to])).rows;
   for(const r of rows){r.time=Number(r.time);r.closeTime=Number(r.closeTime);r.synthetic=!!(r.raw_data?.synthetic??r.raw_data?.candle?.synthetic);}
   await zip(`${output}/${job.index}-before.json.gz`,rows);job.beforeCount=rows.length;
  }
  const evidence={cutoff,endpoint,append,runs,watches,events,orders,jobs:[...jobs.values()],engineVersion:ENGINE_VERSION,limitations:['回测为历史可用行情的反事实回放，不复制模拟盘暂停/恢复/准入路径','旧逐笔模式成交不能作为收盘决策模式的一致性验收','异常历史行隔离；引擎仍按原规则补内部缺口，收益仅供诊断','历史接口 volume 的单位未获保证，与 WS volume_usd 差异不能直接判为漏成交']};
  evidence.hash=digest(evidence);await save(`${output}/evidence.json`,evidence);await db.query('COMMIT');
  log({stage:'snapshot',cutoff,jobs:jobs.size,runs:runs.length,cas:new Set(watches.map(w=>`${w.chain}:${w.ca}`)).size});
  const results=[],queue=[...jobs.values()];
  async function work(){for(;;){const j=queue.shift();if(!j)break;const step=j.interval==='30s'?30000:60000,rows=new Map(),invalid=[],failures=[];let windows=0;
   for(let from=j.from;from<j.to;from+=5000*step){const req={...j,from,to:Math.min(j.to,from+5000*step)};windows++;
    try{const raw=await requestHistory(endpoint,req);await zip(`${output}/${j.index}-window-${windows}.json.gz`,{request:req,response:raw});const parsed=inspectHistory(raw,req);
     invalid.push(...parsed.invalid);for(const c of parsed.valid)rows.set(c.time,{...c,traceId:parsed.traceId});
    }catch(e){failures.push({from:req.from,to:req.to,error:String(e)});}
   }
   const history=[...rows.values()].sort((a,b)=>a.time-b.time),before=await unzip(`${output}/${j.index}-before.json.gz`),comparison=compareCandles(history,before);let inserted=0;
   if(append)for(let i=0;i<history.length;i+=250){const part=history.slice(i,i+250),args=part.flatMap(c=>[j.chain,j.ca,j.pairId,j.interval,c.time,c.closeTime,c.open,c.high,c.low,c.close,c.volume,j.type,JSON.stringify({audit:'paper-history-comparison',cutoff,endpoint,upstream:'xxyy',traceId:c.traceId})]);
    const result=await db.query(`INSERT INTO meme_kline(chain,ca,pair_id,interval,open_time,close_time,open,high,low,close,volume,type,raw_data,source,valid) VALUES ${part.map((_,n)=>`(${Array.from({length:13},(_,k)=>`$${n*13+k+1}`).join(',')},'memeinfo_xxyy',true)`).join(',')} ON CONFLICT(chain,pair_id,interval,open_time,type) DO NOTHING`,args);inserted+=result.rowCount;
   }
   await zip(`${output}/${j.index}-history.json.gz`,history);await zip(`${output}/${j.index}-invalid.json.gz`,invalid);
   const r={...j,windows,validRows:history.length,invalidRows:invalid.length,failures,inserted,comparison};results.push(r);await save(`${output}/${j.index}-result.json`,r);log({stage:'history',index:j.index,chain:j.chain,ca:j.ca,type:j.type,valid:history.length,invalid:invalid.length,inserted,failed:failures.length,overlap:comparison.overlap});
  }}
  await Promise.all([work(),work()]);
  const replays=[];
  for(const run of runs){const own=watches.filter(w=>w.run_id===run.id&&w.pair_id&&Number(w.signal_time)<cutoff),gates=own.map(w=>({chain:w.chain,ca:w.ca,signalTime:Number(w.signal_time)}));
   if(!own.length){replays.push({id:run.id,name:run.name,skipped:'无已纳入且有池的信号项目'});continue;}
   const historyInputs=[],storedInputs=[],hybridInputs=[];
   for(const w of own){const j=results.find(j=>j.chain===w.chain&&j.ca===w.ca&&j.pairId===w.pair_id&&j.interval===run.interval&&j.type===run.value_type);if(!j)continue;
    const h=await unzip(`${output}/${j.index}-history.json.gz`),b=await unzip(`${output}/${j.index}-before.json.gz`),symbol={chain:w.chain,ca:w.ca,pairId:w.pair_id};
    const numeric=r=>({time:Number(r.time),closeTime:Number(r.closeTime),...Object.fromEntries(fields.map(k=>[k,Number(r[k])])),valid:r.valid!==false,synthetic:!!r.synthetic});
    const valid=r=>r.valid!==false&&fields.every(k=>Number.isFinite(Number(r[k])))&&Number(r.low)>0&&Number(r.high)>=Math.max(Number(r.open),Number(r.close))&&Number(r.low)<=Math.min(Number(r.open),Number(r.close))&&Number(r.volume)>=0;
    historyInputs.push({symbol,candles:h.map(numeric)});storedInputs.push({symbol,candles:b.filter(valid).map(numeric)});
    const observed=new Map(b.filter(r=>r.source==='meme_market_v2'&&valid(r)).map(r=>[r.time,r]));
    // Common timestamp substitution isolates OHLCV differences, not coverage or availability.
    hybridInputs.push({symbol,candles:h.map(r=>numeric(observed.get(r.time)??r))});
   }
   const config={...run.strategy_json,interval:run.interval,valueType:run.value_type,entryAfterSignal:true,entrySignals:gates,executionConfig:{...run.strategy_json.executionConfig,initialCapital:Number(run.initial_capital)}};
   const variants={};for(const [label,input] of Object.entries({history:historyInputs,stored:storedInputs,commonTimeWsSubstitution:hybridInputs})){const result=replay(config,input);await zip(`${output}/${run.id}-${label}.json.gz`,result);variants[label]={trades:result.report.totalTrades,net:result.report.netPnl,returnPercent:result.report.returnPercent,endCount:result.endCount,endNet:result.endNet,normalNet:result.normalNet,gapBars:result.generatedGapBars,openPositions:result.report.openPositions.length,signalHash:digest(result.signals),tradeHash:digest(result.trades)};}
   const fills=orders.filter(o=>o.run_id===run.id&&o.status==='filled'),switched=new Date(run.execution_switched_at).getTime();
   replays.push({id:run.id,name:run.name,cas:own.length,variants,paper:{realizedPnl:Number(run.realized_pnl),filledBuys:fills.filter(o=>o.side==='buy').length,filledSells:fills.filter(o=>o.side==='sell').length,filledSinceClosedBarSwitch:fills.filter(o=>Number(o.decision_time)>=switched).length,filledSinceNewWs:fills.filter(o=>Number(o.decision_time)>=new Date(run.market_switched_at).getTime()).length}});
   log({stage:'replay',...replays.at(-1)});
  }
  // Confirm old fill facts were not changed by the insert-only import.
  const after=(await db.query('SELECT o.*,f.fill_time,f.fill_value,f.fill_price,f.quantity,f.gross_amount,f.fee,f.slippage_cost,f.tax_cost FROM live_orders o LEFT JOIN live_fills f ON f.order_id=o.id WHERE o.run_id=ANY($1::uuid[]) AND o.decision_time<=$2 ORDER BY o.id',[ids,cutoff])).rows;for(const o of after)delete o.raw_result;
  const oldFills=orders.filter(o=>o.status==='filled'),afterFills=after.filter(o=>o.status==='filled'&&oldFills.some(p=>p.id===o.id));
  assert.equal(digest(oldFills),digest(afterFills),'已有成交记录发生变化，需要人工核查');
  const report={cutoff,evidenceHash:evidence.hash,append,oldFilledOrdersUnchanged:true,results:results.sort((a,b)=>a.index-b.index),replays,limitations:evidence.limitations};await save(`${output}/report.json`,report);log({stage:'complete',output,inserted:results.reduce((n,r)=>n+r.inserted,0),invalid:results.reduce((n,r)=>n+r.invalidRows,0)});return report;
 }finally{await db.end();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){assert(process.env.DATABASE_URL,'DATABASE_URL required');await audit({connectionString:process.env.DATABASE_URL,output:process.argv[2],append:process.argv.includes('--append')});}
