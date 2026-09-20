import { BadRequestException } from '@nestjs/common';
import type { Pool } from 'pg';

export function includesEnd(q:Record<string,string>) {
  if(q.includeEndOfBacktest!==undefined && !['true','false'].includes(q.includeEndOfBacktest)) throw new BadRequestException('includeEndOfBacktest 必须为 true 或 false');
  return q.includeEndOfBacktest!=='false';
}
const key=(r:any)=>JSON.stringify([r.chain,r.ca,r.pair_id]);
const present=(v:any)=>v!==null && v!==undefined && Number.isFinite(Number(v));
const same=(a:any,b:any)=>present(a)&&present(b)&&Math.abs(Number(a)-Number(b))<=1e-9*Math.max(1,Math.abs(Number(a)),Math.abs(Number(b)));
const exits=new Set(['take_profit','stop_loss','profit_lock','invalidation','timeout','end_of_backtest']);

/** Read-time enrichment only. Never persist guesses into immutable historical results. */
export function enrichResults(rawTrades:any[],rawSignals:any[],config:any) {
 const trades=rawTrades.map(t=>({...t})),signals=rawSignals.map(s=>({...s}));
 const pools=new Map<string,{trades:any[];signals:any[]}>();
 for(const r of [...trades,...signals]){const k=key(r);if(!pools.has(k))pools.set(k,{trades:[],signals:[]});pools.get(k)![r.signal_type?'signals':'trades'].push(r);}
 for(const group of pools.values()){
  group.trades.sort((a,b)=>Number(a.entry_time)-Number(b.entry_time)||Number(a.trade_no)-Number(b.trade_no)||String(a.id).localeCompare(String(b.id)));
  const entryMap=new Map<number,any[]>(),exitMap=new Map<number,any[]>(),addMap=new Map<number,any[]>(),numberMap=new Map<number,any[]>(),buys=new Map<string,any[]>();
  const append=(map:Map<any,any[]>,k:any,v:any)=>{if(!map.has(k))map.set(k,[]);map.get(k)!.push(v);};
  for(const t of group.trades){append(entryMap,Number(t.entry_time),t);if(t.exit_time!=null)append(exitMap,Number(t.exit_time),t);for(const time of new Set((t.adds_json ?? []).map((a:any)=>Number(a.time))))append(addMap,time,t);}
  for(const [i,t] of group.trades.entries()){
   t.trade_no ??= entryMap.get(Number(t.entry_time))!.length===1?i+1:null;
   if(t.trade_no!=null)append(numberMap,t.trade_no,t);
   t.holding_ms=present(t.exit_time)?Number(t.exit_time)-Number(t.entry_time):null;
   t.excluded_end=t.exit_reason==='end_of_backtest';
  }
  for(const s of group.signals){
   let matches:any[]=[];
   if(s.trade_no!=null) matches=numberMap.get(s.trade_no) ?? [];
   else matches=(s.signal_type==='entry'?entryMap:s.signal_type==='add'?addMap:exitMap).get(Number(s.time))?.filter(t=>{
    if(s.signal_type==='entry')return Number(t.entry_time)===Number(s.time);
    if(s.signal_type==='add')return (t.adds_json ?? []).some((a:any)=>Number(a.time)===Number(s.time)&&same(a.price,s.price)&&same(a.quantity,s.quantity));
    if(exits.has(s.signal_type))return t.exit_reason===s.signal_type && Number(t.exit_time)===Number(s.time)&&same(t.exit_price,s.price)&&same(t.quantity,s.quantity);
    return false;
   }) ?? [];
   const t=matches.length===1?matches[0]:undefined;
   s.trade_id=t?.id ?? null;s.excluded_end=t?.excluded_end ?? (s.signal_type==='end_of_backtest');
   s.association_available=!!t || s.trade_no!=null;
   if(t){s.trade_no ??=t.trade_no;
    if(s.event_order==null){if(s.signal_type==='entry')s.event_order=1;else if(exits.has(s.signal_type))s.event_order=(t.adds_json?.length ?? 0)+2;
     else if(s.signal_type==='add'){const matching=(t.adds_json ?? []).map((a:any,i:number)=>({a,i})).filter(({a}:any)=>Number(a.time)===Number(s.time)&&same(a.price,s.price)&&same(a.quantity,s.quantity));if(matching.length===1)s.event_order=matching[0].i+2;}}
   }
   s.event_label=s.trade_no==null?null:s.signal_type==='entry'?`买${s.trade_no}`:s.signal_type==='add'&&s.event_order!=null?`加${s.trade_no}.${s.event_order-1}`:exits.has(s.signal_type)?`卖${s.trade_no}`:null;
   if(t&&['entry','add'].includes(s.signal_type))append(buys,t.id,s);
  }
  for(const t of group.trades){
   const buy=buys.get(t.id) ?? [];
   const first=buy.filter(s=>s.signal_type==='entry');t.first_entry_price ??=first.length===1?first[0].price:null;
   let basis: number|null=null;
   if(['buy_amount','buy_fees','buy_slippage_cost','buy_tax_cost'].every(k=>present(t[k])))basis=Number(t.buy_amount)+Number(t.buy_fees)+Number(t.buy_slippage_cost)+Number(t.buy_tax_cost);
   else if(first.length===1 && buy.length===1+(t.adds_json?.length ?? 0) && buy.every(s=>present(s.quantity)&&present(s.price))){
    const amount=buy.reduce((n,s)=>n+Number(s.quantity)*Number(s.price),0),quantity=buy.reduce((n,s)=>n+Number(s.quantity),0),e=config.executionConfig;
    if(same(quantity,t.quantity)&&same(amount,Number(t.entry_price)*Number(t.quantity))&&e&&['feePercent','slippagePercent','buyTaxPercent'].every(k=>present(e[k])))basis=amount*(1+(e.feePercent+e.slippagePercent+e.buyTaxPercent)/100);
   }
   t.buy_cost_basis=basis;t.net_return_percent=basis!==null&&basis>0&&present(t.net_pnl)?Number(t.net_pnl)/basis*100:null;
  }
 }
 return {trades,signals};
}

export async function loadResults(pool:Pool,id:string,q:Record<string,string>={}) {
 const args:any[]=[id],where=['run_id=$1'];
 for(const [param,column] of [['chain','chain'],['ca','ca'],['pairId','pair_id']])if(q[param]){args.push(q[param]);where.push(`${column}=$${args.length}`);}
 const [t,s,c]=await Promise.all([pool.query(`SELECT * FROM backtest_trades WHERE ${where.join(' AND ')} ORDER BY entry_time,id`,args),pool.query(`SELECT * FROM backtest_signals WHERE ${where.join(' AND ')} ORDER BY time,trade_no,event_order,id`,args),pool.query('SELECT config_json FROM backtest_runs WHERE id=$1',[id])]);
 return enrichResults(t.rows,s.rows,c.rows[0]?.config_json ?? {});
}

export function filteredStatistics(trades:any[],signals:any[],capital:number,start:number,includeEnd:boolean){
 const excluded=includeEnd?[]:trades.filter(t=>t.exit_reason==='end_of_backtest');
 const selected=trades.filter(t=>present(t.exit_time) && (includeEnd || t.exit_reason!=='end_of_backtest'));
 const buckets=new Map<number,number>(),reasons=new Map<string,any>();const missingPnl=selected.filter(t=>!present(t.net_pnl)).length;
 let net=0,wins=0;
 for(const t of selected){const pnl=Number(t.net_pnl ?? 0),time=Number(t.exit_time);net+=pnl;wins+=pnl>0?1:0;buckets.set(time,(buckets.get(time)??0)+pnl);
  const reason=t.exit_reason ?? 'unknown';if(!reasons.has(reason))reasons.set(reason,{reason,count:0,netPnl:0,wins:0,missingPnl:0});const r=reasons.get(reason);r.count++;r.netPnl+=pnl;r.wins+=pnl>0?1:0;r.missingPnl+=present(t.net_pnl)?0:1;
 }
 let balance=capital,peak=capital,drawdown=0,drawdownPercent=0;
 const first=trades.reduce((n,t)=>Math.min(n,Number(t.entry_time)),start);const curve=[{time:Number.isFinite(first)?first:start,equity:capital}];
 for(const [time,pnl]of [...buckets].sort((a,b)=>a[0]-b[0])){balance+=pnl;peak=Math.max(peak,balance);drawdown=Math.max(drawdown,peak-balance);drawdownPercent=Math.max(drawdownPercent,peak>0?(peak-balance)/peak*100:0);curve.push({time,equity:balance});}
 const counts=new Map<string,number>();for(const s of signals)if(includeEnd || !s.excluded_end)counts.set(s.signal_type,(counts.get(s.signal_type)??0)+1);
 return {summary:{netPnl:missingPnl?null:net,totalNetPnl:missingPnl?null:net,unrealizedPnl:null,totalTrades:selected.length,winRate:selected.length&&!missingPnl?wins/selected.length:null,returnPercent:capital>0&&!missingPnl?net/capital*100:null,finalEquity:missingPnl?null:balance,maxDrawdown:missingPnl?null:drawdown,maxDrawdownPercent:missingPnl?null:drawdownPercent},curve:missingPnl?[]:curve,missingPnl,
  excluded:{count:excluded.length,netPnl:excluded.some(t=>!present(t.net_pnl))?null:excluded.reduce((n,t)=>n+Number(t.net_pnl),0)},
  exitReasons:[...reasons.values()].map(r=>({...r,netPnl:r.missingPnl?null:r.netPnl,share:r.count/selected.length,winRate:r.missingPnl?null:r.wins/r.count})),signalCounts:[...counts].map(([type,count])=>({type,count})),unassociatedSignals:signals.filter(s=>!s.association_available&&s.signal_type!=='risk_event').length};
}

export async function statistics(pool:Pool,run:any,q:Record<string,string>){
 const includeEnd=includesEnd(q),data=await loadResults(pool,run.id);
 const result=filteredStatistics(data.trades,data.signals,run.config_json.executionConfig.initialCapital,run.config_json.startTime?Date.parse(run.config_json.startTime):data.trades.length?Number(data.trades[0].entry_time):new Date(run.created_at).getTime(),includeEnd);
 const original=(await pool.query('SELECT report_json FROM backtest_reports WHERE run_id=$1',[run.id])).rows[0]?.report_json ?? null;
 const originalCurve=(await pool.query('SELECT time,equity FROM (SELECT *,ROW_NUMBER() OVER(ORDER BY time) rn,COUNT(*) OVER() total FROM backtest_equity_curve WHERE run_id=$1) p WHERE rn=1 OR rn=total OR rn % GREATEST(total/2000,1)=0 ORDER BY time',[run.id])).rows;
 return {...result,summary:includeEnd?{...original,...(original?{winRate:original.totalTrades?original.winRate:null}:result.summary)}:{...result.summary,engineVersion:original?.engineVersion},curve:includeEnd?originalCurve:result.curve,original,originalCurve,partial:run.status!=='completed',includeEndOfBacktest:includeEnd};
}
