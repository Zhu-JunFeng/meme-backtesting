import { Pool } from 'pg';
import { Worker } from 'bullmq';
import { createQueue, executeRun, reconcile, queuePrefix, redisConnection } from '@meme/runtime';
import {LiveService} from './live-service.js';
const pool=new Pool({connectionString:process.env.DATABASE_URL,statement_timeout:60000});
const queue=createQueue();
const live=new LiveService(pool);
let stopping=false,reconciling=false;
const worker=new Worker('backtest',async job=>{
 await executeRun(pool,job.data.runId,()=>stopping);
 const run=(await pool.query('SELECT status FROM backtest_runs WHERE id=$1',[job.data.runId])).rows[0];
 if(run?.status!=='completed')throw new Error('执行已暂停、移交或停止；以任务数据库状态为准');
},{prefix:queuePrefix(),connection:redisConnection(),concurrency:1});
worker.on('error',error=>console.error('worker error',error.message));
worker.on('failed',(job,error)=>console.warn('execution ended',job?.id,error.message));
async function tick(){if(stopping || reconciling)return;reconciling=true;try{await reconcile(pool,queue);}catch(e){console.error('reconcile failed',String(e));}finally{reconciling=false;}}
const timer=setInterval(tick,5000);void tick();
async function shutdown(){if(stopping)return;stopping=true;clearInterval(timer);console.log('保存检查点并停止领取任务');await live.close();await worker.close();await queue.close();await pool.end();}
process.once('SIGTERM',()=>{void shutdown().catch(e=>{console.error(e);process.exitCode=1;});});
process.once('SIGINT',()=>{void shutdown().catch(e=>{console.error(e);process.exitCode=1;});});
console.log('backtest worker started',queuePrefix());
void live.start().catch(error=>{console.error('live service startup failed',String(error));process.exitCode=1;void shutdown().catch(failure=>console.error('worker shutdown failed',String(failure)));});
