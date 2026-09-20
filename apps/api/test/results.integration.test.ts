import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {statistics,loadResults} from '../src/results.js';
import {runCas,resultRows} from '../src/datasets.js';
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('filtered report PostgreSQL integration (migrated test database)',()=>{
 let pool:Pool,run:any;const id=randomUUID();
 beforeAll(async()=>{
  if(!new URL(url!).pathname.includes('test'))throw Error('Only explicit test databases are permitted');
  pool=new Pool({connectionString:url});
  const config={symbols:[{chain:'sol',ca:'a',pairId:'p'},{chain:'sol',ca:'empty',pairId:'empty'}],executionConfig:{initialCapital:1000,feePercent:0,slippagePercent:0,buyTaxPercent:0}};
  run=(await pool.query("INSERT INTO backtest_runs(id,name,status,config_json) VALUES($1,'analytics integration','completed',$2) RETURNING *",[id,JSON.stringify(config)])).rows[0];
  for(const [no,reason,pnl] of [[1,'end_of_backtest',-20],[2,'take_profit',30]] as const){
   await pool.query(`INSERT INTO backtest_trades(run_id,chain,ca,pair_id,entry_time,entry_price,quantity,exit_time,exit_price,fees,slippage_cost,tax_cost,net_pnl,exit_reason,trade_no,first_entry_price,buy_amount,buy_fees,buy_slippage_cost,buy_tax_cost) VALUES($1,'sol','a','p',$2,100,1,$3,$4,0,0,0,$5,$6,$7,100,100,0,0,0)`,[id,no*100,no*100+50,100+pnl,pnl,reason,no]);
   await pool.query(`INSERT INTO backtest_signals(run_id,chain,ca,pair_id,time,price,quantity,signal_type,reason_json,trade_no,event_order) VALUES($1,'sol','a','p',$2,100,1,'entry','{}',$3,1),($1,'sol','a','p',$4,$5,1,$6,'{}',$3,2)`,[id,no*100,no,no*100+50,100+pnl,reason]);
  }
  await pool.query('INSERT INTO backtest_reports(run_id,report_json) VALUES($1,$2)',[id,JSON.stringify({engineVersion:'portfolio-3',totalTrades:2,netPnl:10,totalNetPnl:10,unrealizedPnl:0,winRate:.5,finalEquity:1010,maxDrawdown:20,maxDrawdownPercent:2})]);
  await pool.query('INSERT INTO backtest_equity_curve VALUES($1,100,1000,900,0),($1,150,980,980,0),($1,250,1010,1010,0)',[id]);
 });
 afterAll(async()=>{if(pool){await pool.query('DELETE FROM backtest_runs WHERE id=$1',[id]);await pool.end();}});
 it('all reports, CA sums and trade lists share the filter without mutating originals',async()=>{
  const all=await statistics(pool,run,{}),filtered=await statistics(pool,run,{includeEndOfBacktest:'false'});
  expect(all.summary.netPnl).toBe(10);expect(filtered.summary.netPnl).toBe(30);expect(filtered.excluded).toEqual({count:1,netPnl:-20});expect(filtered.summary.winRate).toBe(1);expect(filtered.curve.at(-1)?.equity).toBe(1030);
  const cas:any=await runCas(pool,run,{includeEndOfBacktest:'false'});expect(cas.total).toBe(2);expect(cas.summary.untradedCaCount).toBe(1);expect(cas.summary.realizedPnl).toBe(filtered.summary.netPnl);
  const trades=await resultRows(pool,id,'trades',{includeEndOfBacktest:'false',page:'1'});expect(trades.total).toBe(1);expect(trades.items[0].trade_no).toBe(2);
  const signals=await resultRows(pool,id,'signals',{includeEndOfBacktest:'false',page:'1'});expect(signals.total).toBe(2);expect(signals.items.filter((s:any)=>s.excluded_end)).toHaveLength(0);
  expect((await statistics(pool,run,{})).original).toEqual(all.original);expect((await loadResults(pool,id)).trades).toHaveLength(2);
 });
 it('signal unions filter CA, pools, paged trades and complete event pairs, not top statistics',async()=>{
  const q={signalTypes:'take_profit,add',includeEndOfBacktest:'false',page:'1',pageSize:'1'};
  const cas:any=await runCas(pool,run,q);expect(cas.total).toBe(1);expect(cas.items[0].ca).toBe('a');expect(cas.items[0].realizedPnl).toBe(30);
  const events:any=await resultRows(pool,id,'signals',q);expect(events.total).toBe(2);expect(events.items[0].event_label).toBe('买2');
  const detail:any=await runCas(pool,run,{...q,chain:'sol',ca:'a'},true);expect(detail.pools[0].trades).toBe(1);
  expect((await statistics(pool,run,{signalTypes:'stop_loss'})).summary.totalTrades).toBe(2);
  const empty:any=await runCas(pool,run,{includeEndOfBacktest:'false',signalTypes:'end_of_backtest'});expect(empty.total).toBe(0);
 });
});
