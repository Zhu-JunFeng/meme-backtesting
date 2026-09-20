import {Pool} from 'pg';
import {spawn} from 'node:child_process';
import {createQueue,enqueue,RUNTIME_VERSION,queuePrefix} from '../dist/index.js';
const url=new URL(process.env.TEST_DATABASE_URL||'');
if(url.hostname!=='127.0.0.1' || !url.pathname.includes('test'))throw Error('Only a local test database is allowed');
const pool=new Pool({connectionString:url.toString()}),queue=createQueue();
const source=process.argv[2];let child;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const start=()=>spawn(process.execPath,['apps/worker/dist/main.js'],{cwd:new URL('../../..',import.meta.url),env:{...process.env,DATABASE_URL:url.toString()},stdio:['ignore','pipe','pipe']});
async function poll(id,predicate){for(let i=0;i<180;i++){const r=(await pool.query('SELECT * FROM backtest_runs WHERE id=$1',[id])).rows[0];if(predicate(r))return r;if(r.status==='failed')throw Error(r.error_message);await wait(500);}throw Error('Timed out');}
try{
 const r=(await pool.query("INSERT INTO backtest_runs(name,status,config_json,runtime_version,queue_scope,phase,input_ready) SELECT 'SIGTERM rehearsal','pending',config_json,$2,$3,'computing',true FROM backtest_runs WHERE id=$1 RETURNING id,dispatch_no",[source,RUNTIME_VERSION,queuePrefix()])).rows[0];
 await pool.query('INSERT INTO backtest_input_chunks SELECT $2,pool_key,chunk_no,candles_json FROM backtest_input_chunks WHERE run_id=$1',[source,r.id]);await pool.query('INSERT INTO backtest_input_pools SELECT $2,pool_key,symbol_json,chunk_count,candle_count,normalized_count,invalid_count FROM backtest_input_pools WHERE run_id=$1',[source,r.id]);
 await enqueue(queue,r);child=start();
 child.stderr.on('data',d=>process.stderr.write(d));child.stdout.on('data',d=>process.stdout.write(d));
 const crash=process.argv.includes('--crash');
 await poll(r.id,x=>Number(x.progress)>.1 && x.status==='running' && (!crash || x.checkpoint_at));
 const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill(crash?'SIGKILL':'SIGTERM');await stopped;
 if(crash){await pool.query("UPDATE backtest_runs SET lease_until=now()-interval '1 second' WHERE id=$1",[r.id]);child=start();child.stderr.on('data',d=>process.stderr.write(d));child.stdout.on('data',d=>process.stdout.write(d));await poll(r.id,x=>x.status==='completed');console.log(JSON.stringify({event:'crash-resumed-complete',id:r.id}));}
 if(!crash){
 const checkpoint=await poll(r.id,x=>x.status==='pending' && x.checkpoint_at);
 console.log(JSON.stringify({event:'graceful-checkpoint',id:r.id,progress:checkpoint.progress,checkpointAt:checkpoint.checkpoint_at}));
 child=start();child.stderr.on('data',d=>process.stderr.write(d));child.stdout.on('data',d=>process.stdout.write(d));
 const done=await poll(r.id,x=>x.status==='completed');console.log(JSON.stringify({event:'resumed-complete',id:r.id,recoveryCount:done.recovery_count,epoch:done.execution_epoch}));
 }
 const reports=(await pool.query('SELECT run_id,report_json FROM backtest_reports WHERE run_id=ANY($1::uuid[])',[[source,r.id]])).rows;
 const a=reports.find(x=>x.run_id===source)?.report_json,b=reports.find(x=>x.run_id===r.id)?.report_json;
 if(JSON.stringify(a)!==JSON.stringify(b))throw Error('Resumed report differs from fixed input baseline');
 console.log('Resumed report exactly matches the fixed-input baseline');
}finally{if(child && child.exitCode===null){const stopped=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await stopped;}await queue.close();await pool.end();}
