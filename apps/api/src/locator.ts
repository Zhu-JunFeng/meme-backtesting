import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { BacktestConfig } from '@meme/domain';
import { intervalMs } from '@meme/engine';
import { tradeFib } from './fib.js';
import { loadResults, selectResults } from './results.js';
export async function locate(pool:Pool,run:any,q:Record<string,string>){
 const config=run.config_json as BacktestConfig;
 const symbol=config.symbols.find(s=>s.chain===q.chain && s.ca===q.ca && s.pairId===q.pairId);
 if(!symbol)throw new BadRequestException('交易池不属于该任务');
 const original=await loadResults(pool,run.id,q),data=selectResults(original,q);let trade:any,event:any;
 if(q.eventId && !original.signals.some(s=>String(s.id)===q.eventId) || q.tradeId && !original.trades.some(t=>String(t.id)===q.tradeId))throw new NotFoundException('交易或事件不存在');
 if(q.eventId)event=data.signals.find(s=>String(s.id)===q.eventId);
 if(!event)trade=data.trades.find(t=>String(t.id)===q.tradeId) ?? data.trades[0];
 if(!trade && !event)return {symbol,empty:true,hiddenUnassociated:data.hiddenUnassociated};
 const step=intervalMs(config.interval),start=Number(event?.time ?? trade.entry_time),end=Number(event?.time ?? trade.exit_time ?? start);
 const snap=config.pools?.find(p=>p.chain===symbol.chain && p.ca===symbol.ca && p.pairId===symbol.pairId);
 let from=Math.max(snap?.startTime ?? 0,start-100*step),to=Math.min(snap?.endTime ?? Number.MAX_SAFE_INTEGER,end+100*step);
 // Select 100 real neighbours, not merely 100 time buckets when source data is sparse.
 if(!run.input_ready){
 const bounds=await pool.query(`SELECT (SELECT min(open_time) FROM (SELECT open_time FROM public.meme_kline WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND valid IS DISTINCT FROM false AND open_time<$6 AND open_time>=$8 ORDER BY open_time DESC LIMIT 100) b) AS before,(SELECT max(open_time) FROM (SELECT open_time FROM public.meme_kline WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND valid IS DISTINCT FROM false AND open_time>$7 AND open_time<=$9 ORDER BY open_time LIMIT 100) a) AS after`,[symbol.chain,symbol.ca,symbol.pairId,config.interval,config.valueType,start,end,snap?.startTime ?? 0,snap?.endTime ?? Date.now()]);
 from=Number(bounds.rows[0].before ?? start);to=Number(bounds.rows[0].after ?? end);
 }else{
 const rows=(await pool.query(`WITH bars AS (SELECT (b->>'time')::bigint t FROM backtest_input_chunks c CROSS JOIN LATERAL jsonb_array_elements(c.candles_json) b WHERE c.run_id=$1 AND c.pool_key=$2) SELECT (SELECT min(t) FROM (SELECT t FROM bars WHERE t<$3 ORDER BY t DESC LIMIT 100) x) AS before,(SELECT max(t) FROM (SELECT t FROM bars WHERE t>$4 ORDER BY t LIMIT 100) x) AS after`,[run.id,`${symbol.chain}:${symbol.ca}:${symbol.pairId}`,start,end])).rows;
 from=Number(rows[0].before ?? start);to=Number(rows[0].after ?? end);
 }
 const events=data.signals.filter(s=>Number(s.time)>=start&&Number(s.time)<=end);
 const fib=await tradeFib(pool,run,q,trade?.id,event?.id);
 let fibFrom=from,fibTo=to;
 if(fib.status==='available'){
  fibFrom=Math.max(snap?.startTime ?? 0,fib.low.time-100*step);
  fibTo=Math.min(snap?.endTime ?? to,(fib.exitTime ?? snap?.endTime ?? to)+100*step);
  if(run.input_ready){
   const bounds=(await pool.query(`WITH bars AS (SELECT (b->>'time')::bigint t FROM backtest_input_chunks c CROSS JOIN LATERAL jsonb_array_elements(c.candles_json) b WHERE c.run_id=$1 AND c.pool_key=$2) SELECT (SELECT min(t) FROM (SELECT t FROM bars WHERE t<$3 ORDER BY t DESC LIMIT 100) x) AS before,(SELECT max(t) FROM (SELECT t FROM bars WHERE t>$4 ORDER BY t LIMIT 100) x) AS after, min(t) AS first,max(t) AS last FROM bars`,[run.id,`${symbol.chain}:${symbol.ca}:${symbol.pairId}`,fib.low.time,fib.exitTime ?? fib.entryTime])).rows[0];
   fibFrom=Number(bounds.before ?? bounds.first ?? fib.low.time);fibTo=Number(fib.exitTime==null?bounds.last ?? to:bounds.after ?? bounds.last ?? to);
  }
 }
 return {symbol,tradeId:trade?.id,eventId:event?.id,from,to,start,end,events,fib,fibFrom,fibTo,interval:config.interval,valueType:config.valueType,empty:false};
}
