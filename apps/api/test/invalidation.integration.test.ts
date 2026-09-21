import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {loadResults,statistics} from '../src/results.js';
import {resultRows,runCas} from '../src/datasets.js';
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('frozen invalidation evidence PostgreSQL integration',()=>{
 let pool:Pool,run:any;const id=randomUUID(),owner=randomUUID();
 beforeAll(async()=>{
  if(!new URL(url!).pathname.includes('test'))throw Error('Explicit test DB only');
  pool=new Pool({connectionString:url});
  const config={interval:'30s',valueType:'mcap',symbols:[{chain:'sol',ca:'a',pairId:'p'}],executionConfig:{initialCapital:1000},invalidationConditionGroup:{mode:'any',conditions:[{type:'break_fib_invalidation',ratio:.886},{type:'break_swing_low_invalidation',bufferPercent:0},{type:'bearish_volume_invalidation',period:10,minRatio:2,minBodyPercent:20}]}};
  await pool.query("INSERT INTO backtest_runs(id,name,status,config_json,input_ready) VALUES($1,'frozen owner','completed',$2,true)",[owner,JSON.stringify(config)]);
  for(const [index,c]of [{time:0,open:100,high:100,low:100,close:100,volume:10},{time:30000,open:200,high:200,low:160,close:160,volume:20}].entries())await pool.query('INSERT INTO backtest_input_chunks VALUES($1,$2,$3,$4)',[owner,'sol:a:p',index,JSON.stringify([{...c,closeTime:c.time+30000,valid:true}])]);
  run=(await pool.query("INSERT INTO backtest_runs(id,name,status,config_json,input_ready,input_source_run_id) VALUES($1,'invalidation evidence','completed',$2,true,$3) RETURNING *",[id,JSON.stringify(config),owner])).rows[0];
  await pool.query('INSERT INTO backtest_reports(run_id,report_json) VALUES($1,$2)',[id,JSON.stringify({engineVersion:'portfolio-4',netPnl:60,totalTrades:1})]);
  await pool.query(`INSERT INTO backtest_trades(run_id,chain,ca,pair_id,entry_time,entry_price,quantity,exit_time,exit_price,fees,slippage_cost,tax_cost,net_pnl,exit_reason,trade_no) VALUES($1,'sol','a','p',0,100,1,30000,160,0,0,0,60,'invalidation',1)`,[id]);
  await pool.query(`INSERT INTO backtest_signals(run_id,chain,ca,pair_id,time,price,quantity,signal_type,reason_json,trade_no,event_order) VALUES($1,'sol','a','p',0,100,1,'entry',$2,1,1),($1,'sol','a','p',30000,160,1,'invalidation','{"priority":"invalidation"}',1,2)`,[id,JSON.stringify({impulse:{low:100,high:300,confirmedTime:0}})]);
 });
 afterAll(async()=>{if(pool){await pool.query('DELETE FROM backtest_runs WHERE id=$1',[id]);await pool.query('DELETE FROM backtest_runs WHERE id=$1',[owner]);await pool.end();}});
 it('restores old shared-input exits, exposes full pair filtering, and never persists enrichment',async()=>{
  const r=await loadResults(pool,id);expect(r.trades[0].invalidation_detail).toMatchObject({source:'frozen_input',primary:'bearish_volume_invalidation'});expect(r.signals[1].invalidation_detail).toEqual(r.trades[0].invalidation_detail);
  const q={includeEndOfBacktest:'false',signalTypes:'invalidation:bearish_volume_invalidation',page:'1'};
  expect((await resultRows(pool,id,'signals',q)).total).toBe(2);expect((await runCas(pool,run,q)).total).toBe(1);
  const s=await statistics(pool,run,q);expect(s.invalidationReasons).toHaveLength(1);expect(s.invalidationReasons[0]).toMatchObject({count:1,netPnl:60,winRate:1});
  expect((await pool.query("SELECT reason_json FROM backtest_signals WHERE run_id=$1 AND signal_type='invalidation'",[id])).rows[0].reason_json).toEqual({priority:'invalidation'});
  expect((await pool.query('SELECT report_json FROM backtest_reports WHERE run_id=$1',[id])).rows[0].report_json).toEqual({engineVersion:'portfolio-4',netPnl:60,totalTrades:1});
 });
});
