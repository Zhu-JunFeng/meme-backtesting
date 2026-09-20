import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {executeRun,stopRun,retryRun,rerun,reconcile,fenced,LostLease,queuePrefix,RUNTIME_VERSION} from '../src/index.js';
import {configuration,candles} from '../../engine/test/fixtures.js';
const url=process.env.TEST_DATABASE_URL;
const suite=url?describe:describe.skip;
suite('isolated database recovery integration',()=>{
 let pool:Pool;
 const queue:any={add:async()=>{}};
 const config=configuration();config.symbols=[config.symbols[0]];
 beforeAll(async()=>{
  if(!new URL(url!).pathname.includes('test'))throw new Error('Only explicit test databases are permitted');
  pool=new Pool({connectionString:url});
  await pool.query('CREATE TABLE IF NOT EXISTS meme_kline(chain text,ca text,pair_id text,interval text,type text,open_time bigint,close_time bigint,open numeric,high numeric,low numeric,close numeric,volume numeric,trade_count int,source text,raw_data jsonb,created_at timestamptz default now(),valid boolean,invalid_reason text,PRIMARY KEY(chain,ca,pair_id,interval,type,open_time))');
  await pool.query(readFileSync(new URL('../../../apps/api/migrations/001_init.sql',import.meta.url),'utf8'));
  await pool.query('ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS strategy_template_id uuid; ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS strategy_version_id uuid; ALTER TABLE backtest_runs ADD COLUMN IF NOT EXISTS dataset_json jsonb;');
  await pool.query(readFileSync(new URL('../../../apps/api/migrations/004_resumable.sql',import.meta.url),'utf8'));
  await pool.query(readFileSync(new URL('../../../apps/api/migrations/005_trade_analytics.sql',import.meta.url),'utf8'));
  const data=candles(5000);for(let offset=0;offset<data.length;offset+=500){const part=data.slice(offset,offset+500),values=part.flatMap(c=>['sol','a','a','30s','mcap',c.time,c.closeTime,c.open,c.high,c.low,c.close,c.volume,true]);await pool.query(`INSERT INTO meme_kline(chain,ca,pair_id,interval,type,open_time,close_time,open,high,low,close,volume,valid) VALUES ${part.map((_,i)=>'('+Array.from({length:13},(_,j)=>'$'+(i*13+j+1)).join(',')+')').join(',')} ON CONFLICT DO NOTHING`,values);}
 },30000);
 afterAll(async()=>{await pool?.end();});
 async function make(){return (await pool.query("INSERT INTO backtest_runs(name,status,config_json,runtime_version,queue_scope,phase) VALUES('integration','pending',$1,$2,$3,'freezing') RETURNING id",[JSON.stringify(config),RUNTIME_VERSION,queuePrefix()])).rows[0].id as string;}
 async function outputs(id:string){return {report:(await pool.query('SELECT report_json FROM backtest_reports WHERE run_id=$1',[id])).rows[0]?.report_json,signals:(await pool.query('SELECT chain,ca,pair_id,time,price,signal_type,reason_json,quantity FROM backtest_signals WHERE run_id=$1 ORDER BY id',[id])).rows,trades:(await pool.query('SELECT chain,ca,pair_id,entry_time,entry_price,quantity,exit_time,exit_price,net_pnl FROM backtest_trades WHERE run_id=$1 ORDER BY id',[id])).rows,equity:(await pool.query('SELECT time,equity,cash,unrealized FROM backtest_equity_curve WHERE run_id=$1 ORDER BY time',[id])).rows};}
 it('checkpoint resume equals uninterrupted execution; input UPSERT cannot change it',async()=>{
  const baseline=await make();await executeRun(pool,baseline,()=>false);const expected=await outputs(baseline);
  const id=await make();let checks=0;await executeRun(pool,id,()=>++checks>110);
  const stopped=(await pool.query('SELECT * FROM backtest_runs WHERE id=$1',[id])).rows[0];expect(stopped.status).toBe('pending');expect(stopped.checkpoint_at).toBeTruthy();
  await pool.query("UPDATE meme_kline SET volume=volume+1 WHERE ca='a'");
  await executeRun(pool,id,()=>false);expect(await outputs(id)).toEqual(expected);
  await pool.query("UPDATE meme_kline SET volume=volume-1 WHERE ca='a'");
 },30000);
 it('manual stop/retry is idempotent and completed runs cannot be stopped',async()=>{
  const id=await make();await stopRun(pool,id);await stopRun(pool,id);expect((await pool.query('SELECT status FROM backtest_runs WHERE id=$1',[id])).rows[0].status).toBe('stopped');
  expect(await retryRun(pool,queue,id)).toBe(true);expect(await retryRun(pool,queue,id)).toBe(false);await executeRun(pool,id,()=>false);await stopRun(pool,id);expect((await pool.query('SELECT status FROM backtest_runs WHERE id=$1',[id])).rows[0].status).toBe('completed');
 },30000);
 it('rejects stale writers and reconciles expired leases without taking legacy jobs',async()=>{
  const id=await make();await pool.query("UPDATE backtest_runs SET status='running',execution_epoch=1,lease_until=now()-interval '1 second' WHERE id=$1",[id]);
  const c=await pool.connect();try{await expect(fenced(c,id,1)).rejects.toBeInstanceOf(LostLease);}finally{c.release();}
  await reconcile(pool,queue);const r=(await pool.query('SELECT * FROM backtest_runs WHERE id=$1',[id])).rows[0];expect(r.status).toBe('pending');expect(r.execution_epoch).toBe(2);expect(r.recovery_count).toBe(1);
  await pool.query("UPDATE backtest_runs SET status='running',lease_until=now()-interval '1 second',failure_streak=2 WHERE id=$1",[id]);await reconcile(pool,queue);expect((await pool.query('SELECT status FROM backtest_runs WHERE id=$1',[id])).rows[0].status).toBe('failed');
 });
 it('rerun request preserves originals and creates exactly one independent run',async()=>{
  const source=await make(),request=randomUUID();const a=await rerun(pool,queue,source,request),b=await rerun(pool,queue,source,request);expect(a.id).toBe(b.id);expect(a.id).not.toBe(source);
 });
 it('stop racing final publication retains a checkpoint and never publishes a partial report',async()=>{
  const id=await make(),original=pool.query.bind(pool);let injected=false;
  const proxy=new Proxy(pool,{get(target,key){if(key==='query')return async(sql:any,params:any)=>{const result=await original(sql,params);if(typeof sql==='string' && sql.includes("SET phase='saving'") && !injected){injected=true;await stopRun(pool,id);}return result;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
  await executeRun(proxy,id,()=>false);expect((await pool.query('SELECT status FROM backtest_runs WHERE id=$1',[id])).rows[0].status).toBe('stopped');expect((await outputs(id)).report).toBeUndefined();
  await retryRun(pool,queue,id);await executeRun(pool,id,()=>false);const baseline=await make();await executeRun(pool,baseline,()=>false);expect(await outputs(id)).toEqual(await outputs(baseline));
 },30000);
});
