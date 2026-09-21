import type { Pool } from 'pg';
import { inputOwner } from '@meme/runtime';
import { describeInvalidation, intervalMs, validCandle, unavailableInvalidation, invalidationCodes, type InvalidationDetail } from '@meme/engine';
import type { Candle, ConditionGroup } from '@meme/domain';

export const invalidationFilters = Object.fromEntries(invalidationCodes.map(code => [`invalidation:${code}`, code]));
const supported = new Set(['break_fib_invalidation', 'break_swing_low_invalidation', 'bearish_volume_invalidation']);
const leaves = (g: any): any[] => !g || g.enabled === false ? [] : g.conditions ? g.conditions.flatMap(leaves) : [g];
const finite = (n: any) => typeof n === 'number' && Number.isFinite(n);
const close = (a: number, b: number) => Math.abs(a-b) <= 1e-9 * Math.max(Number.MIN_VALUE, Math.abs(a), Math.abs(b));
const cache = new Map<string, InvalidationDetail>();

/** Bounded suffix, preserving FrozenReader's previous-close gap rules; never extrapolate beyond the last raw candle. */
export function invalidationHistory(raw: Candle[], time: number, period: number, step: number): Candle[] {
  const from = time - period * step, result: Candle[] = [];
  const rows = [...raw].sort((a,b) => a.time-b.time);
  for (let i=0; i<rows.length; i++) {
    const c=rows[i], previous=rows[i-1];
    if (!validCandle(c) || i>0 && c.time<=previous.time) throw new Error('冻结行情无效或重复');
    if (previous) {
      const first=previous.time+Math.max(1,Math.ceil((from-previous.time)/step))*step;
      for(let t=first;t<c.time && t<=time;t+=step) result.push({time:t,closeTime:t+step,open:previous.close,high:previous.close,low:previous.close,close:previous.close,volume:0,synthetic:true,valid:true});
    }
    if(c.time>=from && c.time<=time) result.push(c);
    if(c.time>=time) break;
  }
  return result;
}

export function restoreInvalidation(config: any, entry: any, exit: any, raw: Candle[]): InvalidationDetail {
  const group=config.invalidationConditionGroup as ConditionGroup, conditions=leaves(group), impulse=entry?.reason_json?.impulse;
  if(!conditions.length || conditions.some(c=>!supported.has(c.type))) return unavailableInvalidation('历史条件类型不支持可靠还原');
  if(!impulse || !finite(impulse.low) || !finite(impulse.high) || impulse.low<=0 || impulse.high<=impulse.low || Number(entry.time)>Number(exit.time) || finite(impulse.confirmedTime)&&impulse.confirmedTime>Number(entry.time)) return unavailableInvalidation('入场依据缺失或时间矛盾');
  const period=Math.max(1,...conditions.map(c=>c.period ?? 0));
  if(!Number.isInteger(period)||period>2000) return unavailableInvalidation('历史窗口超出可还原范围');
  try {
    const history=invalidationHistory(raw,Number(exit.time),period,intervalMs(config.interval));
    const last=history.at(-1);
    if(!last || last.time!==Number(exit.time) || !close(last.close,Number(exit.price))) return unavailableInvalidation('冻结行情与原退出时间或成交值不一致');
    const detail=describeInvalidation(group,history,impulse);
    return detail.source==='unavailable'?detail:{...detail,source:'frozen_input'};
  } catch { return unavailableInvalidation('冻结行情不完整，无法核验'); }
}

/** Attach query-only evidence. Stored trades/reasons and numerical reports are never changed. */
export async function hydrateInvalidations(pool: Pool, run: any, data: {trades:any[];signals:any[]}) {
  const groups=new Map<string,any[]>();
  for(const s of data.signals)if(s.trade_id!=null){const id=String(s.trade_id);if(!groups.has(id))groups.set(id,[]);groups.get(id)!.push(s);}
  const missing: Array<{trade:any;entry:any;exit:any;cacheKey:string}> = [];
  for(const trade of data.trades.filter(t=>t.exit_reason==='invalidation')) {
    const events=groups.get(String(trade.id)) ?? [], exits=events.filter(s=>s.signal_type==='invalidation'), entries=events.filter(s=>s.signal_type==='entry');
    let detail: InvalidationDetail;
    const saved=exits.length===1?exits[0].reason_json?.invalidation:undefined;
    if(saved?.version===1 && invalidationCodes.includes(saved.primary) && Array.isArray(saved.matches) && saved.matches.length) detail=saved;
    else {
      const cacheKey=`${run.id}:${trade.id}:${exits[0]?.id}`;
      const cached=run.status==='completed'?cache.get(cacheKey):undefined;
      detail=cached ?? unavailableInvalidation('历史细分原因未记录');
      if(!cached && exits.length===1 && entries.length===1 && Number(exits[0].time)===Number(trade.exit_time) && close(Number(exits[0].price),Number(trade.exit_price))) missing.push({trade,entry:entries[0],exit:exits[0],cacheKey});
    }
    trade.invalidation_detail=detail;
  }
  if(missing.length && run.input_ready) {
    const versions=(await pool.query(`SELECT report_json->>'engineVersion' version FROM backtest_reports WHERE run_id=$1 UNION ALL SELECT state_json->'engine'->>'engineVersion' FROM backtest_checkpoints WHERE run_id=$1`,[run.id])).rows;
    const conditions=leaves(run.config_json.invalidationConditionGroup), period=Math.max(1,...conditions.map(c=>c.period ?? 0));
    if(versions.some(r=>['portfolio-3','portfolio-4'].includes(r.version)) && conditions.length && conditions.every(c=>supported.has(c.type)) && Number.isInteger(period) && period<=2000) {
      const step=intervalMs(run.config_json.interval);
      const wanted=missing.map(({trade,exit})=>({id:String(trade.id),key:`${trade.chain}:${trade.ca}:${trade.pair_id}`,from:Number(exit.time)-period*step,to:Number(exit.time)}));
      // Only overlapping chunks plus one predecessor/successor. No mutable meme_kline reads.
      const rows=(await pool.query(`WITH wanted AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS w(id text,key text,"from" bigint,"to" bigint))
        SELECT w.id,c.chunk_no,c.candles_json FROM wanted w CROSS JOIN LATERAL (
          (SELECT chunk_no,candles_json FROM backtest_input_chunks WHERE run_id=$1 AND pool_key=w.key AND (candles_json->0->>'time')::bigint<=w."to" AND (candles_json->-1->>'time')::bigint>=w."from")
          UNION
          (SELECT chunk_no,candles_json FROM backtest_input_chunks WHERE run_id=$1 AND pool_key=w.key AND (candles_json->-1->>'time')::bigint<w."from" ORDER BY chunk_no DESC LIMIT 1)
          UNION
          (SELECT chunk_no,candles_json FROM backtest_input_chunks WHERE run_id=$1 AND pool_key=w.key AND (candles_json->0->>'time')::bigint>w."to" ORDER BY chunk_no LIMIT 1)
        ) c ORDER BY w.id,c.chunk_no`,[inputOwner(run),JSON.stringify(wanted)])).rows;
      const chunks=new Map<string,any[]>();for(const r of rows){if(!chunks.has(r.id))chunks.set(r.id,[]);chunks.get(r.id)!.push(r);}
      for(const item of missing) {
        const blocks=chunks.get(String(item.trade.id)) ?? [];
        const complete=blocks.length>0 && blocks.every((b,i)=>!i || b.chunk_no===blocks[i-1].chunk_no+1);
        item.trade.invalidation_detail=complete?restoreInvalidation(run.config_json,item.entry,item.exit,blocks.flatMap(b=>b.candles_json)):unavailableInvalidation('冻结行情缺失，无法核验');
      }
    }
  }
  for(const item of missing)if(run.status==='completed'){
    if(cache.size>=5000)cache.delete(cache.keys().next().value!);
    cache.set(item.cacheKey,item.trade.invalidation_detail);
  }
  for(const trade of data.trades)if(trade.invalidation_detail)for(const signal of groups.get(String(trade.id)) ?? [])if(signal.signal_type==='invalidation')signal.invalidation_detail=trade.invalidation_detail;
  return data;
}
