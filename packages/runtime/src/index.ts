import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { Queue } from 'bullmq';
export const RUNTIME_VERSION='checkpoint-1';
export const queuePrefix=()=>process.env.BACKTEST_QUEUE_PREFIX || (process.env.NODE_ENV==='production'?'meme-production-v3':'meme-local-v3');
export const redisConnection=()=>({host:process.env.REDIS_HOST ?? 'localhost',port:Number(process.env.REDIS_PORT ?? 6379),password:process.env.REDIS_PASSWORD});
export const configHash=(c:unknown)=>createHash('sha256').update(JSON.stringify(c)).digest('hex');
export function createQueue(){return new Queue('backtest',{prefix:queuePrefix(),connection:redisConnection()});}
export class LostLease extends Error {constructor(){super('执行租约已失效，停止旧执行器');}}
export async function fenced(client:PoolClient,id:string,epoch:number){
 const r=await client.query("SELECT status FROM backtest_runs WHERE id=$1 AND execution_epoch=$2 AND lease_until>now() AND status IN ('running','stopping') FOR UPDATE",[id,epoch]);if(!r.rowCount)throw new LostLease();return r.rows[0].status as string;
}
export async function heartbeat(pool:Pool,id:string,epoch:number){
 const r=await pool.query("UPDATE backtest_runs SET heartbeat_at=now(),lease_until=now()+interval '60 seconds' WHERE id=$1 AND execution_epoch=$2 AND lease_until>now() AND status IN ('running','stopping') RETURNING status",[id,epoch]);if(!r.rowCount)throw new LostLease();return r.rows[0].status as string;
}
export async function enqueue(queue:Queue,run:any){await queue.add('run',{runId:run.id},{jobId:`${run.id}-${run.dispatch_no ?? 0}`,removeOnComplete:100,removeOnFail:100});}
export async function reconcile(pool:Pool,queue:Queue){
 const c=await pool.connect();try{await c.query('BEGIN');
 await c.query("UPDATE backtest_runs SET status=CASE WHEN status='stopping' THEN 'stopped' WHEN failure_streak>=2 THEN 'failed' ELSE 'pending' END, execution_epoch=execution_epoch+1,dispatch_no=dispatch_no+1,recovery_count=recovery_count+1,failure_streak=failure_streak+1,lease_until=NULL,error_message=CASE WHEN status='stopping' THEN NULL ELSE '执行心跳丢失；从已提交检查点恢复' END,finished_at=CASE WHEN status='stopping' OR failure_streak>=2 THEN now() ELSE NULL END WHERE queue_scope=$1 AND runtime_version=$2 AND status IN ('running','stopping') AND lease_until<now()",[queuePrefix(),RUNTIME_VERSION]);
 const rows=(await c.query("SELECT id,dispatch_no FROM backtest_runs WHERE queue_scope=$1 AND runtime_version=$2 AND status='pending' ORDER BY created_at LIMIT 100",[queuePrefix(),RUNTIME_VERSION])).rows;await c.query('COMMIT');
 for(const r of rows)await enqueue(queue,r);
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
export function actions(run:any){const local=run.runtime_version===RUNTIME_VERSION && run.queue_scope===queuePrefix();return {stop:['pending','running'].includes(run.status) && local,retry:['stopped','cancelled','failed'].includes(run.status) && local,rerun:true};}
export async function stopRun(pool:Pool,id:string){
 await pool.query("UPDATE backtest_runs SET status=CASE WHEN status='running' THEN 'stopping' ELSE 'stopped' END,finished_at=CASE WHEN status='running' THEN NULL ELSE now() END WHERE id=$1 AND runtime_version=$2 AND queue_scope=$3 AND status IN ('pending','running')",[id,RUNTIME_VERSION,queuePrefix()]);
}
export async function retryRun(pool:Pool,queue:Queue,id:string){
 const r=await pool.query("UPDATE backtest_runs SET status='pending',failure_streak=0,error_message=NULL,finished_at=NULL,dispatch_no=dispatch_no+1 WHERE id=$1 AND status IN ('stopped','failed','cancelled') AND runtime_version=$2 AND queue_scope=$3 RETURNING id,dispatch_no",[id,RUNTIME_VERSION,queuePrefix()]);if(r.rowCount)await enqueue(queue,r.rows[0]);
 return !!r.rowCount;
}
export async function rerun(pool:Pool,queue:Queue,id:string,requestId:string){
 const c=await pool.connect();let result:any;
 try{await c.query('BEGIN');await c.query('SELECT id FROM backtest_runs WHERE id=$1 FOR UPDATE',[id]);
 const previous=await c.query('SELECT new_run_id,source_run_id FROM backtest_rerun_requests WHERE request_id=$1',[requestId]);
 if(previous.rowCount){if(previous.rows[0].source_run_id!==id)throw new Error('幂等请求标识已用于其他任务');result={id:previous.rows[0].new_run_id};}
 else{const r=await c.query("INSERT INTO backtest_runs(name,status,config_json,strategy_template_id,strategy_version_id,dataset_json,parent_run_id,runtime_version,queue_scope,phase,strategy_description_json) SELECT name || ' · 重新回测','pending',config_json,strategy_template_id,strategy_version_id,dataset_json,id,$2,$3,'freezing',strategy_description_json FROM backtest_runs WHERE id=$1 RETURNING id,dispatch_no",[id,RUNTIME_VERSION,queuePrefix()]);if(!r.rowCount)throw new Error('任务不存在');result=r.rows[0];await c.query('INSERT INTO backtest_rerun_requests VALUES($1,$2,$3)',[requestId,id,result.id]);}
 await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 const r=(await pool.query('SELECT id,status,dispatch_no FROM backtest_runs WHERE id=$1',[result.id])).rows[0];if(r.status==='pending')await enqueue(queue,r);return r;
}
export { randomUUID };
export * from './runner.js';
export * from './input.js';
