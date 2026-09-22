// Internal CLI only; deliberately no HTTP bulk execution endpoint.
process.env.BACKTEST_CLI='1';
import {generateStrategyDescription} from '@meme/domain';
const {AppService}=await import('./main.js');
import{BATCH,SOURCES,BASE_VERSION,combinations,batchId,digest,PILOTS}from'./batch-grid.js';
import{enqueue,queuePrefix,RUNTIME_VERSION,validateInputSource}from'@meme/runtime';
import{statistics}from'./results.js';
import{advanceRolling,initializeRolling,rollingStatus,type RollingContext}from'./rolling-batch.js';
const service=new AppService(),pool=service.pool;
const command=process.argv[2] ?? 'preview';
const templateId=batchId('template');
const sources:any={};
const csv=(v:any)=>'"'+String(v??'').replaceAll('"','""')+'"';
async function list(){return(await pool.query("SELECT r.*,p.report_json FROM backtest_runs r LEFT JOIN backtest_reports p ON p.run_id=r.id WHERE r.config_json->'batch'->>'id'=$1 ORDER BY r.created_at,r.id",[BATCH])).rows;}
async function main(){
 if(!['preview','pilot','submit','start','advance','pause','status','export'].includes(command))throw new Error('命令：preview | pilot | start | advance | pause | status | export');
 if(command==='status'){console.log(JSON.stringify(await rollingStatus(pool,BATCH),null,2));return;}
 if(command==='pause'){
  if(!process.argv.includes('--yes'))throw new Error('暂停需 --yes');
  await pool.query("UPDATE backtest_batch_control SET status='paused',last_error='用户暂停后续批次；当前任务继续完成',updated_at=now() WHERE batch_id=$1 AND status='active'",[BATCH]);console.log(JSON.stringify(await rollingStatus(pool,BATCH),null,2));return;
 }
 const control=(await pool.query('SELECT * FROM backtest_batch_control WHERE batch_id=$1',[BATCH])).rows[0];
 if(command==='advance'&&control?.status!=='active'){console.log(JSON.stringify({status:control?.status??'not_started'}));return;}
 if(command==='export'){
  const result=[];for(const r of await list()){const filtered=await statistics(pool,r,{includeEndOfBacktest:'false'});result.push({chain:r.config_json.batch.chain,combination:r.config_json.batch.key,runId:r.id,status:r.status,url:`http://47.251.140.83:5173/api/backtests/${r.id}`,exitReasons:(await statistics(pool,r,{includeEndOfBacktest:'true'})).exitReasons,report:r.report_json,excludedEndSummary:filtered.summary,strategy:r.config_json.batch.strategyChecksum,config:r.config_json});}
  result.sort((a,b)=>a.chain.localeCompare(b.chain)||(b.report?.returnPercent??-Infinity)-(a.report?.returnPercent??-Infinity)||(a.report?.maxDrawdownPercent??Infinity)-(b.report?.maxDrawdownPercent??Infinity));
  const ledger=(await pool.query('SELECT * FROM backtest_batch_items WHERE batch_id=$1 ORDER BY chain,return_percent DESC NULLS LAST,max_drawdown_percent,ordinal',[BATCH])).rows;
  if(process.argv.includes('--csv')){console.log('chain,combination,runId,state,returnPercent,netPnl,maxDrawdownPercent,totalTrades');for(const r of ledger)console.log([r.chain,r.combination,r.run_id,r.state,r.return_percent,r.summary_json?.netPnl,r.max_drawdown_percent,r.summary_json?.totalTrades].map(csv).join(','));}
  else console.log(JSON.stringify({batch:BATCH,warning:'按每链完整净收益率排名；同样本参数筛选，不代表样本外收益',control,ledger,results:result},null,2));return;
 }
 const base=await service.version(BASE_VERSION);const rows=combinations(base.strategyJson);
 for(const r of rows)await service.validateStrategy(r.strategy);
 const manifest=[];
 for(const[chain,id]of Object.entries(SOURCES)){
  const source=(await pool.query('SELECT * FROM backtest_runs WHERE id=$1',[id])).rows[0];
  if(!source||source.strategy_version_id!==BASE_VERSION||source.config_json.interval!=='30s'||source.config_json.valueType!=='mcap')throw new Error('基准任务不匹配');
  await validateInputSource(pool,{input_source_run_id:id,input_ready:true,config_json:source.config_json});sources[chain]=source;
  const input=(await pool.query(`SELECT p.*,c.n,c.first,c.last,c.candles FROM backtest_input_pools p LEFT JOIN LATERAL (SELECT count(*)::int n,min(chunk_no) first,max(chunk_no) last,sum(jsonb_array_length(candles_json)) candles FROM backtest_input_chunks WHERE run_id=p.run_id AND pool_key=p.pool_key) c ON true WHERE p.run_id=$1 ORDER BY p.pool_key`,[id])).rows;
  if(input.length!==source.config_json.symbols.length||input.some(p=>p.n!==p.chunk_count||Number(p.candles??0)!==p.candle_count||(p.n>0&&(p.first!==0||p.last!==p.n-1))))throw new Error('冻结输入不完整');
  const report=(await pool.query('SELECT report_json FROM backtest_reports WHERE run_id=$1',[id])).rows[0]?.report_json;if(!report)throw new Error('基准报告缺失');
  source.sourceReport=report;
  manifest.push({chain,id,pools:input.length,candles:input.reduce((n,p)=>n+p.candle_count,0),ticks:input.reduce((n,p)=>n+Number(p.normalized_count),0),reportChecksum:digest(report),inputChecksum:digest(input)});
 }
 const tasks=rows.flatMap(r=>Object.keys(SOURCES).map(chain=>({row:r,chain,id:batchId(`run:${r.number}:${chain}`),pilot:r.number===0 || PILOTS.indexOf(r.number)>0 && (PILOTS.indexOf(r.number)%2===1?chain==='sol':chain==='robin')})));
 if(tasks.length!==1730)throw new Error('任务总量不符');
 const summary={batch:BATCH,strategies:rows.length,total:tasks.length,pilots:tasks.filter(t=>t.pilot).length,manifest,manifestChecksum:digest({rows,manifest}),queue:queuePrefix(),databaseBytes:Number((await pool.query('SELECT pg_database_size(current_database()) n')).rows[0].n)};
 if(command==='preview'){console.log(JSON.stringify({...summary,combinations:rows.map(r=>({number:r.number,key:r.key,checksum:r.checksum,strategy:r.strategy}))},null,2));return;}
 if(!process.argv.includes('--yes'))throw new Error('真实提交需显式 --yes');
 if(queuePrefix()!=='meme-production-v3')throw new Error('此固定批次只允许提交生产队列');
 const free=Number(process.env.BATCH_FREE_BYTES);
 const ctx:RollingContext={batch:BATCH,manifestChecksum:summary.manifestChecksum,tasks:tasks.map((t,ordinal)=>({id:t.id,chain:t.chain,ordinal,key:t.row.key,checksum:t.row.checksum})),sourceIds:Object.values(SOURCES),queueScope:queuePrefix(),freeBytes:free,
  enqueue:async id=>{const r=(await pool.query('SELECT id,dispatch_no FROM backtest_runs WHERE id=$1',[id])).rows[0];if(r)await enqueue(service.queue,r);},
  create:async(c,item)=>{
   const t=tasks.find(t=>t.id===item.id)!;
   // A retained or pruned ledger item is never passed here. Unexpected rows fail closed.
   if((await c.query('SELECT 1 FROM backtest_runs WHERE id=$1',[t.id])).rowCount)throw new Error('计划任务已存在，拒绝重复创建');
   const source=sources[t.chain],versionId=t.row.number===0?BASE_VERSION:batchId(`version:${t.row.number}`);
   if(t.row.number){await c.query("INSERT INTO backtest_strategy_templates(id,name,description,status) VALUES($1,$2,'已确认有限候选全组合；非无限参数穷举','draft') ON CONFLICT(id) DO NOTHING",[templateId,BATCH]);await c.query('INSERT INTO backtest_strategy_versions(id,template_id,version,schema_version,strategy_json,checksum,description_json) VALUES($1,$2,$3,1,$4,$5,$6) ON CONFLICT(id) DO NOTHING',[versionId,templateId,t.row.number,JSON.stringify(t.row.strategy),t.row.checksum,JSON.stringify(generateStrategyDescription(t.row.strategy))]);await c.query('UPDATE backtest_strategy_templates SET current_version_id=$2 WHERE id=$1',[templateId,versionId]);}
   const name=`${BATCH} · ${t.chain.toUpperCase()} · ${String(t.row.number).padStart(3,'0')} ${t.row.key}`;
   const persisted=(await c.query('SELECT strategy_json,description_json,version FROM backtest_strategy_versions WHERE id=$1',[versionId])).rows[0];if(digest(persisted?.strategy_json)!==t.row.checksum)throw new Error('策略版本幂等内容冲突');
   const config={...source.config_json,...structuredClone(t.row.strategy),name,strategyTemplateId:t.row.number?templateId:base.templateId,strategyVersionId:versionId,batch:{id:BATCH,key:t.row.key,number:t.row.number,chain:t.chain,strategyChecksum:t.row.checksum,manifestChecksum:summary.manifestChecksum,sourceReportChecksum:digest(source.sourceReport)}};
   await c.query("INSERT INTO backtest_runs(id,name,status,config_json,dataset_json,strategy_template_id,strategy_version_id,parent_run_id,input_source_run_id,input_ready,runtime_version,queue_scope,phase,strategy_description_json) VALUES($1,$2,'pending',$3,$4,$5,$6,$7,$7,true,$8,$9,'computing',$10)",[t.id,name,JSON.stringify(config),source.dataset_json,config.strategyTemplateId,versionId,source.id,RUNTIME_VERSION,queuePrefix(),persisted.description_json ? JSON.stringify({...persisted.description_json,version:persisted.version,executionOverrides:{}}) : null]);
  }};
 if(command==='pilot'){
  if(control)throw new Error('滚动批次已经建立；禁止重建已淘汰先导任务');
  if(!Number.isFinite(free)||free<2*1024**3)throw new Error('磁盘余量不足');
  let submitted=0;for(const t of ctx.tasks.filter(t=>tasks.find(x=>x.id===t.id)!.pilot)){const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[BATCH]);if(!(await c.query('SELECT 1 FROM backtest_runs WHERE id=$1',[t.id])).rowCount){await ctx.create(c,t);submitted++;}await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}await ctx.enqueue(t.id);}console.log(JSON.stringify({...summary,submitted}));return;
 }
 if(command==='start'||command==='submit'){
  let evidence=control?.pilot_evidence;
  if(!control){
   const existing=await list();for(const t of tasks.filter(t=>t.pilot))if(existing.find(r=>r.id===t.id)?.status!=='completed')throw new Error('先导任务未全部完成，禁止开始');
   for(const chain of Object.keys(SOURCES)){
    const reference=existing.find(r=>r.id===batchId(`run:0:${chain}`));if(digest(reference.report_json)!==digest(sources[chain].sourceReport))throw new Error(`对照报告不一致：${chain}`);
    for(const[table,order]of [['backtest_trades','entry_time,trade_no,id'],['backtest_signals','time,trade_no,event_order,id']]){const read=async(id:string)=>(await pool.query(`SELECT to_jsonb(t)-'id'-'run_id' row FROM ${table} t WHERE run_id=$1 ORDER BY ${order}`,[id])).rows.map(r=>r.row);if(digest(await read(reference.id))!==digest(await read(sources[chain].id)))throw new Error(`对照事件不一致：${chain}/${table}`);}
   }
   evidence={validatedAt:new Date().toISOString(),manifest,pilotRunIds:tasks.filter(t=>t.pilot).map(t=>t.id),ranking:'returnPercent DESC, maxDrawdownPercent ASC, ordinal ASC',includeEndOfBacktest:true};
  }
  await initializeRolling(pool,ctx,evidence);
 }
 console.log(JSON.stringify({cycle:await advanceRolling(pool,ctx),batch:await rollingStatus(pool,BATCH)},null,2));
}
try{await main();}catch(e){
 if(['advance','start','submit'].includes(command))try{await pool.query("UPDATE backtest_batch_control SET status='paused',last_error=$2,updated_at=now() WHERE batch_id=$1 AND status='active'",[BATCH,String(e)]);}catch{/* Preserve the original error if the database is unavailable. */}
 console.error(String(e));process.exitCode=1;
}finally{await service.onModuleDestroy();}
