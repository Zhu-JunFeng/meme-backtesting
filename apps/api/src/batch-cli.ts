// Internal CLI only; deliberately no HTTP bulk execution endpoint.
process.env.BACKTEST_CLI='1';
const {AppService}=await import('./main.js');
import{BATCH,SOURCES,BASE_VERSION,combinations,batchId,digest,PILOTS}from'./batch-grid.js';
import{enqueue,queuePrefix,RUNTIME_VERSION,validateInputSource}from'@meme/runtime';
import{statistics}from'./results.js';
const service=new AppService(),pool=service.pool;
const command=process.argv[2] ?? 'preview';
const templateId=batchId('template');
const sources:any={};
const csv=(v:any)=>'"'+String(v??'').replaceAll('"','""')+'"';
async function list(){return(await pool.query("SELECT r.*,p.report_json FROM backtest_runs r LEFT JOIN backtest_reports p ON p.run_id=r.id WHERE r.config_json->'batch'->>'id'=$1 ORDER BY r.created_at,r.id",[BATCH])).rows;}
async function main(){
 if(!['preview','pilot','submit','status','export'].includes(command))throw new Error('命令：preview | pilot | submit | status | export');
 if(command==='status'){const rows=await list();console.log(JSON.stringify({batch:BATCH,total:rows.length,status:rows.reduce((a,r)=>(a[r.status]=(a[r.status]??0)+1,a),{}),failed:rows.filter(r=>r.status==='failed').map(r=>({id:r.id,error:r.error_message})),active:rows.filter(r=>['running','pending'].includes(r.status)).slice(0,3).map(r=>({id:r.id,name:r.name,status:r.status,progress:r.progress}))},null,2));return;}
 if(command==='export'){
  const result=[];for(const r of await list()){const filtered=await statistics(pool,r,{includeEndOfBacktest:'false'});result.push({chain:r.config_json.batch.chain,combination:r.config_json.batch.key,runId:r.id,status:r.status,url:`http://47.251.140.83:5173/api/backtests/${r.id}`,exitReasons:(await statistics(pool,r,{includeEndOfBacktest:'true'})).exitReasons,report:r.report_json,excludedEndSummary:filtered.summary,durationSeconds:r.finished_at?(new Date(r.finished_at).getTime()-new Date(r.created_at).getTime())/1000:null,strategy:r.config_json.batch.strategyChecksum,config:r.config_json});}
  result.sort((a,b)=>a.chain.localeCompare(b.chain)||(b.report?.netPnl??-Infinity)-(a.report?.netPnl??-Infinity)||(a.report?.maxDrawdown??Infinity)-(b.report?.maxDrawdown??Infinity));
  if(process.argv.includes('--csv')){const keys=['chain','combination','runId','status','netPnl','returnPercent','winRate','totalTrades','maxDrawdown','filteredNetPnl'];console.log(keys.join(','));for(const r of result)console.log([r.chain,r.combination,r.runId,r.status,r.report?.netPnl,r.report?.returnPercent,r.report?.winRate,r.report?.totalTrades,r.report?.maxDrawdown,r.excludedEndSummary?.netPnl].map(csv).join(','));}
  else console.log(JSON.stringify({batch:BATCH,warning:'同历史样本参数筛选，不代表样本外收益',results:result},null,2));return;
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
 const free=Number(process.env.BATCH_FREE_BYTES);if(!Number.isFinite(free)||free<5*1024**3)throw new Error('必须提供数据库磁盘实际可用 BATCH_FREE_BYTES，且至少保留 5 GiB');
 const existing=await list();
 if(command==='submit'){
  const pilotTasks=tasks.filter(t=>t.pilot);for(const t of pilotTasks){const run=existing.find(r=>r.id===t.id);if(run?.status!=='completed')throw new Error('先导任务未全部完成，禁止全量提交');}
  for(const chain of Object.keys(SOURCES)){
   const control=existing.find(r=>r.id===batchId(`run:0:${chain}`));
   if(digest(control.report_json)!==digest(sources[chain].sourceReport))throw new Error(`对照报告不一致：${chain}`);
   for(const[table,order]of [['backtest_trades','entry_time,trade_no,id'],['backtest_signals','time,trade_no,event_order,id']]){
    const read=async(id:string)=>(await pool.query(`SELECT to_jsonb(t)-'id'-'run_id' row FROM ${table} t WHERE run_id=$1 ORDER BY ${order}`,[id])).rows.map(r=>r.row);
    if(digest(await read(control.id))!==digest(await read(sources[chain].id)))throw new Error(`对照事件不一致：${chain}/${table}`);
   }
  }
  // Conservative storage estimate using the largest observed result footprint per chain.
  let estimate=0;for(const chain of Object.keys(SOURCES)){let largest=0;for(const t of pilotTasks.filter(t=>t.chain===chain)){let size=0;for(const table of ['backtest_trades','backtest_signals','backtest_equity_curve','backtest_checkpoints','backtest_reports'])size+=Number((await pool.query(`SELECT coalesce(sum(pg_column_size(t)),0) n FROM ${table} t WHERE run_id=$1`,[t.id])).rows[0].n);largest=Math.max(largest,size);}estimate+=largest*tasks.filter(t=>t.chain===chain&&!existing.some(r=>r.id===t.id)).length*3;}
  if(estimate+5*1024**3>free)throw new Error(`剩余磁盘不足，预计新增（3 倍余量）${estimate} 字节，可用 ${free}；暂停，不删除历史数据`);
  console.error(JSON.stringify({estimatedAdditionalBytes:estimate,freeBytes:free}));
 }
 let submitted=0;
 for(const t of tasks.filter(t=>command==='submit'||t.pilot)){
  const c=await pool.connect();let created:any;try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[BATCH]);
   const exists=(await c.query('SELECT * FROM backtest_runs WHERE id=$1',[t.id])).rows[0];
   if(exists){if(exists.config_json.batch?.strategyChecksum!==t.row.checksum||exists.input_source_run_id!==SOURCES[t.chain as keyof typeof SOURCES])throw new Error('幂等任务内容冲突');await c.query('COMMIT');continue;}
   const source=sources[t.chain],versionId=t.row.number===0?BASE_VERSION:batchId(`version:${t.row.number}`);
   if(t.row.number){await c.query("INSERT INTO backtest_strategy_templates(id,name,description,status) VALUES($1,$2,'已确认有限候选全组合；非无限参数穷举','draft') ON CONFLICT(id) DO NOTHING",[templateId,BATCH]);await c.query('INSERT INTO backtest_strategy_versions(id,template_id,version,schema_version,strategy_json,checksum) VALUES($1,$2,$3,1,$4,$5) ON CONFLICT(id) DO NOTHING',[versionId,templateId,t.row.number,JSON.stringify(t.row.strategy),t.row.checksum]);await c.query('UPDATE backtest_strategy_templates SET current_version_id=$2 WHERE id=$1',[templateId,versionId]);}
   const name=`${BATCH} · ${t.chain.toUpperCase()} · ${String(t.row.number).padStart(3,'0')} ${t.row.key}`;
   const persisted=(await c.query('SELECT strategy_json FROM backtest_strategy_versions WHERE id=$1',[versionId])).rows[0];if(digest(persisted?.strategy_json)!==t.row.checksum)throw new Error('策略版本幂等内容冲突');
   const config={...source.config_json,...structuredClone(t.row.strategy),name,strategyTemplateId:t.row.number?templateId:base.templateId,strategyVersionId:versionId,batch:{id:BATCH,key:t.row.key,number:t.row.number,chain:t.chain,strategyChecksum:t.row.checksum,manifestChecksum:summary.manifestChecksum,sourceReportChecksum:digest(source.sourceReport)}};
   created=(await c.query("INSERT INTO backtest_runs(id,name,status,config_json,dataset_json,strategy_template_id,strategy_version_id,parent_run_id,input_source_run_id,input_ready,runtime_version,queue_scope,phase) VALUES($1,$2,'pending',$3,$4,$5,$6,$7,$7,true,$8,$9,'computing') RETURNING id,dispatch_no",[t.id,name,JSON.stringify(config),source.dataset_json,config.strategyTemplateId,versionId,source.id,RUNTIME_VERSION,queuePrefix()])).rows[0];await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  await enqueue(service.queue,created);submitted++;
  if(submitted%20===0)console.error(`已新增 ${submitted} 个任务`);
 }
 console.log(JSON.stringify({...summary,submitted},null,2));
}
try{await main();}catch(e){console.error(String(e));process.exitCode=1;}finally{await service.onModuleDestroy();}
