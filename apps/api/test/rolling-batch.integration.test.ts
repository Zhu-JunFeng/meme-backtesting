import{beforeAll,afterAll,describe,it,expect}from'vitest';
import{Pool}from'pg';import{readFileSync}from'node:fs';import{randomUUID}from'node:crypto';
import{initializeRolling,advanceRolling,rollingStatus,type RollingContext}from'../src/rolling-batch.js';
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('rolling batch transactions',()=>{
 let pool:Pool;
 beforeAll(async()=>{if(!new URL(url!).pathname.includes('test'))throw new Error('test database only');pool=new Pool({connectionString:url});for(const file of ['004_resumable.sql','006_shared_input.sql','007_rolling_batch.sql'])await pool.query(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));});
 afterAll(async()=>pool?.end());
 async function setup(count=70){
  const batch=randomUUID(),source=randomUUID(),config={symbols:[],interval:'30s',valueType:'mcap'};
  await pool.query("INSERT INTO backtest_runs(id,name,status,config_json,input_ready) VALUES($1,'protected source','completed',$2,true)",[source,JSON.stringify(config)]);
  const ctx:RollingContext={batch,manifestChecksum:'fixed',tasks:Array.from({length:count},(_,ordinal)=>({id:randomUUID(),ordinal,chain:ordinal%2?'robin':'sol',key:String(ordinal),checksum:'strategy-'+ordinal})),sourceIds:[source],queueScope:'test',freeBytes:20*1024**3,enqueue:async()=>{},create:async(c,t)=>{await c.query("INSERT INTO backtest_runs(id,name,status,config_json,input_source_run_id,input_ready,queue_scope) VALUES($1,'rolling','pending',$2,$3,true,'test')",[t.id,JSON.stringify({...config,batch:{id:batch,chain:t.chain,strategyChecksum:t.checksum}}),source]);}};
  return ctx;
 }
 async function complete(ctx:RollingContext){for(const t of ctx.tasks){const r=await pool.query("UPDATE backtest_runs SET status='completed',finished_at=now() WHERE id=$1 AND status='pending' RETURNING id",[t.id]);if(r.rowCount){await pool.query('INSERT INTO backtest_reports VALUES($1,$2,now())',[t.id,JSON.stringify({returnPercent:t.ordinal,maxDrawdownPercent:0,netPnl:t.ordinal,totalTrades:1})]);await pool.query('INSERT INTO backtest_equity_curve VALUES($1,1,100,100,0)',[t.id]);}}}
 it('caps admission at 50, waits for the entire wave, prunes to ten per chain and never resubmits tombstones',async()=>{
  const ctx=await setup();await initializeRolling(pool,ctx,{});
  expect((await advanceRolling(pool,ctx)).admitted).toBe(50);expect((await advanceRolling(pool,ctx)).status).toBe('waiting');
  await complete(ctx);const second=await advanceRolling(pool,ctx);expect(second.deleted).toBe(30);expect(second.admitted).toBe(20);
  expect((await pool.query("SELECT count(*) n FROM backtest_runs WHERE config_json->'batch'->>'id'=$1",[ctx.batch])).rows[0].n).toBe('40');
  await complete(ctx);expect((await advanceRolling(pool,ctx)).status).toBe('completed');expect((await advanceRolling(pool,ctx)).status).toBe('completed');
  const status:any=await rollingStatus(pool,ctx.batch);expect(status.leaders).toHaveLength(20);expect(status.counts.find((r:any)=>r.state==='pruned').count).toBe(50);
  expect((await pool.query('SELECT 1 FROM backtest_runs WHERE id=$1',ctx.sourceIds)).rowCount).toBe(1);
  const tombstone=(await pool.query("SELECT run_id FROM backtest_batch_items WHERE batch_id=$1 AND state='pruned' LIMIT 1",[ctx.batch])).rows[0].run_id;
  expect((await pool.query('SELECT 1 FROM backtest_equity_curve WHERE run_id=$1',[tombstone])).rowCount).toBe(0);
 },30000);
 it('adopts completed pilots without duplication and refuses manifest changes',async()=>{
  const ctx=await setup(12),c=await pool.connect();try{await ctx.create(c,ctx.tasks[0]);}finally{c.release();}await complete(ctx);await initializeRolling(pool,ctx,{ok:true});expect((await advanceRolling(pool,ctx)).admitted).toBe(11);await expect(initializeRolling(pool,{...ctx,manifestChecksum:'changed'},{})).rejects.toThrow('清单改变');
 });
 it('pauses on failure or inadequate space without submitting another batch',async()=>{
  const ctx=await setup(60);await initializeRolling(pool,ctx,{});await advanceRolling(pool,ctx);await pool.query("UPDATE backtest_runs SET status='failed' WHERE id=$1",[ctx.tasks[0].id]);await expect(advanceRolling(pool,ctx)).rejects.toThrow('失败');expect((await rollingStatus(pool,ctx.batch)).status).toBe('paused');
  const low=await setup(10);await initializeRolling(pool,low,{});await expect(advanceRolling(pool,{...low,freeBytes:1})).rejects.toThrow('空间不足');expect((await rollingStatus(pool,low.batch)).status).toBe('paused');
 });
 it('rolls back the entire prune transaction if a deletion fails',async()=>{
  const ctx=await setup(50);await initializeRolling(pool,ctx,{});await advanceRolling(pool,ctx);await complete(ctx);let deletes=0;
  const proxy=new Proxy(pool,{get(target,k){if(k==='connect')return async()=>{const c=await pool.connect();return new Proxy(c,{get(client,key){if(key==='query')return async(sql:any,args:any)=>{if(String(sql).startsWith('DELETE FROM backtest_runs')&&++deletes===2)throw new Error('injected deletion failure');return client.query(sql,args);};const v=Reflect.get(client,key);return typeof v==='function'?v.bind(client):v;}});};const v=Reflect.get(target,k);return typeof v==='function'?v.bind(target):v;}});
  await expect(advanceRolling(proxy,ctx)).rejects.toThrow('injected');expect((await pool.query("SELECT count(*) n FROM backtest_runs WHERE config_json->'batch'->>'id'=$1",[ctx.batch])).rows[0].n).toBe('50');expect((await pool.query("SELECT count(*) n FROM backtest_batch_items WHERE batch_id=$1 AND state='pruned'",[ctx.batch])).rows[0].n).toBe('0');
 },30000);
 it('concurrent coordinators cannot double-admit',async()=>{const ctx=await setup(60);await initializeRolling(pool,ctx,{});await Promise.all([advanceRolling(pool,ctx),advanceRolling(pool,ctx)]);expect((await pool.query("SELECT count(*) n FROM backtest_batch_items WHERE batch_id=$1 AND state='submitted'",[ctx.batch])).rows[0].n).toBe('50');});
 it('preserves evidence and pauses when a completed report is missing',async()=>{const ctx=await setup(2);await initializeRolling(pool,ctx,{});await advanceRolling(pool,ctx);await complete(ctx);await pool.query('DELETE FROM backtest_reports WHERE run_id=$1',[ctx.tasks[0].id]);await expect(advanceRolling(pool,ctx)).rejects.toThrow('报告');expect((await rollingStatus(pool,ctx.batch)).status).toBe('paused');expect((await pool.query('SELECT 1 FROM backtest_runs WHERE id=$1',[ctx.tasks[0].id])).rowCount).toBe(1);});
 it('does not delete a loser referenced by a user-created rerun',async()=>{const ctx=await setup(30);await initializeRolling(pool,ctx,{});await advanceRolling(pool,ctx);await complete(ctx);await pool.query("INSERT INTO backtest_runs(name,status,config_json,parent_run_id) VALUES('unrelated child','completed','{}',$1)",[ctx.tasks[0].id]);await expect(advanceRolling(pool,ctx)).rejects.toThrow();expect((await rollingStatus(pool,ctx.batch)).status).toBe('paused');expect((await pool.query("SELECT count(*) n FROM backtest_runs WHERE config_json->'batch'->>'id'=$1",[ctx.batch])).rows[0].n).toBe('30');});
});
