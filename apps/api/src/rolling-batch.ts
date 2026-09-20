import type {Pool,PoolClient} from 'pg';

export const RESULT_TABLES=['backtest_trades','backtest_signals','backtest_equity_curve','backtest_checkpoints','backtest_reports','backtest_result_batches'] as const;
export type RollingTask={id:string;chain:string;ordinal:number;key:string;checksum:string};
export type RollingContext={batch:string;manifestChecksum:string;tasks:RollingTask[];sourceIds:string[];freeBytes:number;queueScope:string;create:(c:PoolClient,t:RollingTask)=>Promise<void>;enqueue:(id:string)=>Promise<void>};
export const compareScore=(a:any,b:any)=>Number(b.return_percent)-Number(a.return_percent)||Number(a.max_drawdown_percent)-Number(b.max_drawdown_percent)||a.ordinal-b.ordinal;
export function winningIds(items:any[],keep=10){
 const ids=new Set<string>();for(const chain of new Set(items.map(i=>i.chain)))for(const item of items.filter(i=>i.chain===chain&&i.summary_json?.status==='completed'&&Number.isFinite(i.return_percent)&&Number.isFinite(i.max_drawdown_percent)).sort(compareScore).slice(0,keep))ids.add(item.run_id);return ids;
}
const finite=(value:any)=>typeof value==='number'&&Number.isFinite(value);
const compactReport=(r:any)=>Object.fromEntries(['netPnl','returnPercent','maxDrawdown','maxDrawdownPercent','totalTrades','winRate','profitFactor','finalEquity'].map(k=>[k,r?.[k]??null]));
export async function rollingStatus(pool:Pool,batch:string){
 const control=(await pool.query('SELECT * FROM backtest_batch_control WHERE batch_id=$1',[batch])).rows[0];if(!control)return {batch,status:'not_started'};
 const counts=(await pool.query('SELECT state,count(*)::int count FROM backtest_batch_items WHERE batch_id=$1 GROUP BY state',[batch])).rows;
 const leaders=(await pool.query("SELECT chain,run_id,combination,return_percent,max_drawdown_percent,summary_json FROM backtest_batch_items WHERE batch_id=$1 AND state='retained' ORDER BY chain,return_percent DESC,max_drawdown_percent,ordinal",[batch])).rows;
 const active=(await pool.query("SELECT r.id,r.name,r.status,r.progress FROM backtest_batch_items i JOIN backtest_runs r ON r.id=i.run_id WHERE i.batch_id=$1 AND i.state='submitted' ORDER BY i.ordinal",[batch])).rows;
 return {...control,counts,leaders,active};
}
export async function initializeRolling(pool:Pool,ctx:RollingContext,evidence:any){
 const c=await pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[ctx.batch]);
 const old=(await c.query('SELECT * FROM backtest_batch_control WHERE batch_id=$1 FOR UPDATE',[ctx.batch])).rows[0];
 if(old){if(old.manifest_checksum!==ctx.manifestChecksum)throw new Error('滚动清单改变，拒绝恢复');if(old.status!=='completed')await c.query("UPDATE backtest_batch_control SET status='active',last_error=NULL,updated_at=now() WHERE batch_id=$1",[ctx.batch]);await c.query('COMMIT');return;}
 await c.query("INSERT INTO backtest_batch_control(batch_id,manifest_checksum,status,total,pilot_evidence) VALUES($1,$2,'active',$3,$4)",[ctx.batch,ctx.manifestChecksum,ctx.tasks.length,JSON.stringify(evidence)]);
 for(const t of ctx.tasks){
  if(ctx.sourceIds.includes(t.id))throw new Error('来源任务不得加入淘汰清单');
  const r=(await c.query('SELECT * FROM backtest_runs WHERE id=$1',[t.id])).rows[0];
  if(r&&(r.config_json.batch?.id!==ctx.batch||r.config_json.batch?.strategyChecksum!==t.checksum||!ctx.sourceIds.includes(r.input_source_run_id)||r.queue_scope!==ctx.queueScope))throw new Error('现有任务身份不匹配');
  await c.query('INSERT INTO backtest_batch_items(batch_id,run_id,ordinal,chain,combination,strategy_checksum,state,wave) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.batch,t.id,t.ordinal,t.chain,t.key,t.checksum,r?'submitted':'planned',r?0:null]);
 }
 await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
/** One transactional settle/prune/admit cycle. Only a completed wave may advance. */
export async function advanceRolling(pool:Pool,ctx:RollingContext){
 const c=await pool.connect();let locked=false;let deleted=0;const admitted:string[]=[];
 try{
  locked=(await c.query('SELECT pg_try_advisory_lock(hashtext($1)) ok',[ctx.batch])).rows[0].ok;if(!locked)return {busy:true};
  let control=(await c.query('SELECT * FROM backtest_batch_control WHERE batch_id=$1',[ctx.batch])).rows[0];if(!control||control.status!=='active')return {status:control?.status??'not_started'};
  if(control.manifest_checksum!==ctx.manifestChecksum)throw new Error('滚动清单改变，禁止继续');
  let items=(await c.query('SELECT * FROM backtest_batch_items WHERE batch_id=$1 ORDER BY ordinal',[ctx.batch])).rows;
  if(items.length!==ctx.tasks.length)throw new Error('滚动执行清单不完整');
  const live=(await c.query("SELECT r.*,p.report_json FROM backtest_batch_items i JOIN backtest_runs r ON r.id=i.run_id LEFT JOIN backtest_reports p ON p.run_id=r.id WHERE i.batch_id=$1 AND i.state IN ('submitted','retained')",[ctx.batch])).rows;
  for(const item of items.filter(i=>['submitted','retained'].includes(i.state))){const r=live.find(r=>r.id===item.run_id);if(!r)throw new Error('未淘汰的任务意外缺失，暂停以免重复执行');if(r.config_json.batch?.id!==ctx.batch||r.config_json.batch?.strategyChecksum!==item.strategy_checksum||r.config_json.batch?.chain!==item.chain||!ctx.sourceIds.includes(r.input_source_run_id)||ctx.sourceIds.includes(r.id)||r.queue_scope!==ctx.queueScope)throw new Error('删除边界校验失败');}
  if(live.some(r=>['stopped','cancelled','failed'].includes(r.status)))throw new Error('本轮存在停止或失败任务；请先重试处理，不自动删除失败证据');
  if(live.some(r=>r.status!=='completed'))return {status:'waiting',wave:control.wave};
  // Ranking evidence and deletion commit together, including all previous winners.
  await c.query('BEGIN');
  for(const r of live){
   if(!finite(r.report_json?.returnPercent)||!finite(r.report_json?.maxDrawdownPercent))throw new Error('完整报告收益率或回撤缺失，禁止排名删除');
   const stored=items.find(i=>i.run_id===r.id);let bytes=Number(stored?.result_bytes??0);
   if(!bytes)for(const table of RESULT_TABLES)bytes+=Number((await c.query(`SELECT coalesce(sum(pg_column_size(t)),0) n FROM ${table} t WHERE run_id=$1`,[r.id])).rows[0].n);
   await c.query('UPDATE backtest_batch_items SET return_percent=$3,max_drawdown_percent=$4,summary_json=$5,result_bytes=$6,finished_at=$7 WHERE batch_id=$1 AND run_id=$2',[ctx.batch,r.id,r.report_json.returnPercent,r.report_json.maxDrawdownPercent,JSON.stringify({status:r.status,...compactReport(r.report_json)}),bytes,r.finished_at]);
  }
  items=(await c.query('SELECT * FROM backtest_batch_items WHERE batch_id=$1 ORDER BY ordinal',[ctx.batch])).rows;
  const winners=winningIds(items,control.keep_per_chain);
  if(items.some(i=>i.state==='pruned'&&winners.has(i.run_id)))throw new Error('历史排名证据变化，禁止猜测恢复已淘汰结果');
  for(const item of items.filter(i=>['submitted','retained'].includes(i.state))){
   if(winners.has(item.run_id)){await c.query("UPDATE backtest_batch_items SET state='retained' WHERE batch_id=$1 AND run_id=$2",[ctx.batch,item.run_id]);continue;}
   const result=await c.query("DELETE FROM backtest_runs WHERE id=$1 AND status='completed' AND queue_scope=$2 AND input_source_run_id=ANY($3::uuid[]) AND config_json->'batch'->>'id'=$4 AND config_json->'batch'->>'strategyChecksum'=$5 RETURNING id",[item.run_id,ctx.queueScope,ctx.sourceIds,ctx.batch,item.strategy_checksum]);
   if(result.rowCount!==1)throw new Error('淘汰目标状态改变，整轮删除回滚');
   await c.query("UPDATE backtest_batch_items SET state='pruned',pruned_at=now() WHERE batch_id=$1 AND run_id=$2",[ctx.batch,item.run_id]);deleted++;
  }
  await c.query('UPDATE backtest_batch_control SET updated_at=now(),last_error=NULL WHERE batch_id=$1',[ctx.batch]);await c.query('COMMIT');
  // Normal VACUUM makes deleted space reusable, without VACUUM FULL or table rewrites.
  if(deleted)for(const table of RESULT_TABLES)await c.query(`VACUUM (ANALYZE) ${table}`);
  const planned=items.filter(i=>i.state==='planned').slice(0,control.batch_size);
  if(!planned.length){await c.query("UPDATE backtest_batch_control SET status='completed',updated_at=now() WHERE batch_id=$1",[ctx.batch]);return {status:'completed',deleted};}
  let estimated=0;for(const i of planned){const measured=items.filter(x=>x.chain===i.chain).map(x=>Number(x.result_bytes??0));estimated+=Math.max(1_000_000,...measured)*3;}
  if(!Number.isFinite(ctx.freeBytes)||ctx.freeBytes<estimated+2*1024**3)throw new Error(`下一批空间不足：预算 ${estimated} 字节，另保留 2 GiB，可用 ${ctx.freeBytes}；已淘汰 ${deleted} 个任务，暂停提交`);
  await c.query('BEGIN');
  // Recheck pause request immediately before admission; a paused batch never adds work.
  control=(await c.query('SELECT * FROM backtest_batch_control WHERE batch_id=$1 FOR UPDATE',[ctx.batch])).rows[0];
  if(control.status!=='active'){await c.query('ROLLBACK');return {status:control.status,deleted};}
  for(const i of planned){const t=ctx.tasks.find(t=>t.id===i.run_id);if(!t||t.checksum!==i.strategy_checksum)throw new Error('清单参数冲突');await ctx.create(c,t);await c.query("UPDATE backtest_batch_items SET state='submitted',wave=$3 WHERE batch_id=$1 AND run_id=$2 AND state='planned'",[ctx.batch,t.id,control.wave+1]);admitted.push(t.id);}
  await c.query('UPDATE backtest_batch_control SET wave=wave+1,updated_at=now() WHERE batch_id=$1',[ctx.batch]);await c.query('COMMIT');
  for(const id of admitted)await ctx.enqueue(id);
  return {status:'submitted',wave:control.wave+1,admitted:admitted.length,deleted,estimatedBytes:estimated,freeBytes:ctx.freeBytes};
 }catch(e){await c.query('ROLLBACK');if(locked)await c.query("UPDATE backtest_batch_control SET status='paused',last_error=$2,updated_at=now() WHERE batch_id=$1",[ctx.batch,String(e)]);throw e;}
 finally{if(locked)await c.query('SELECT pg_advisory_unlock(hashtext($1))',[ctx.batch]);c.release();}
}
