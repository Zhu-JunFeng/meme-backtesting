import { BadRequestException } from '@nestjs/common';
import type { Pool } from 'pg';
import { hydrateInvalidations, invalidationFilters } from './invalidation.js';

export function includesEnd(q:Record<string,string>) {
  if(q.includeEndOfBacktest!==undefined && !['true','false'].includes(q.includeEndOfBacktest)) throw new BadRequestException('includeEndOfBacktest 必须为 true 或 false');
  return q.includeEndOfBacktest!=='false';
}
const key=(r:any)=>JSON.stringify([r.chain,r.ca,r.pair_id]);
const present=(v:any)=>v!==null && v!==undefined && Number.isFinite(Number(v));
const same=(a:any,b:any)=>present(a)&&present(b)&&Math.abs(Number(a)-Number(b))<=1e-9*Math.max(1,Math.abs(Number(a)),Math.abs(Number(b)));
const exits=new Set(['take_profit','stop_loss','profit_lock','invalidation','timeout','end_of_backtest']);
const normalExits=new Set(['take_profit','stop_loss','profit_lock','invalidation','timeout']);
const finiteValue=(v:any)=>present(v)&&typeof v!=='boolean'&&String(v).trim()!=='';
/** Query-only classification. Absence of an exit is different from a corrupt exit. */
export function classifyTrade(t:any):{trade_classification:'normal_closed'|'end_of_backtest'|'open'|'incomplete';exclusion_reason:string|null}{
 if(t.exit_reason==='end_of_backtest')return {trade_classification:'end_of_backtest',exclusion_reason:'结束强平'};
 if(t.exit_time==null&&t.exit_price==null&&t.exit_reason==null)return {trade_classification:'open',exclusion_reason:'尚未平仓'};
 if(!normalExits.has(t.exit_reason))return {trade_classification:'incomplete',exclusion_reason:'退出原因缺失或无法识别'};
 if(!finiteValue(t.entry_time)||!finiteValue(t.exit_time)||Number(t.exit_time)<Number(t.entry_time))return {trade_classification:'incomplete',exclusion_reason:'入场或退出时间缺失、无效或顺序矛盾'};
 if(!finiteValue(t.exit_price)||Number(t.exit_price)<=0)return {trade_classification:'incomplete',exclusion_reason:'退出成交值缺失或无效'};
 if(!finiteValue(t.net_pnl))return {trade_classification:'incomplete',exclusion_reason:'净盈亏缺失或无效'};
 return {trade_classification:'normal_closed',exclusion_reason:null};
}
export function signalTypes(q:Record<string,string>):string[]{
 if(q.signalTypes!==undefined&&typeof q.signalTypes!=='string')throw new BadRequestException('交易信号筛选必须为逗号分隔的文本');
 const types=[...new Set((q.signalTypes ?? '').split(',').map(s=>s.trim()).filter(Boolean))];
 if(types.some(t=>!['entry','add',...exits].includes(t)&&!Object.hasOwn(invalidationFilters,t)))throw new BadRequestException('不支持的交易信号筛选');
 return types;
}
/** Filter whole trades after stable association/numbering, before paging or chart windows. */
export function selectResults(data:{trades:any[];signals:any[]},q:Record<string,string>){
 const includeEnd=includesEnd(q),types=signalTypes(q),byTrade=new Map<string,Set<string>>();
 for(const s of data.signals)if(s.trade_id!=null){const id=String(s.trade_id);if(!byTrade.has(id))byTrade.set(id,new Set());byTrade.get(id)!.add(s.signal_type);}
 const trades=data.trades.map(t=>({...t,...classifyTrade(t)})).filter(t=>(includeEnd || t.trade_classification==='normal_closed')&&(!types.length || types.some(type=>Object.hasOwn(invalidationFilters,type)?t.exit_reason==='invalidation'&&(t.invalidation_detail?.primary ?? 'unknown')===invalidationFilters[type]:exits.has(type)?t.exit_reason===type:byTrade.get(String(t.id))?.has(type))));
 const ids=new Set(trades.map(t=>String(t.id)));
 const signals=data.signals.filter(s=>s.trade_id!=null?ids.has(String(s.trade_id)):!types.length&&(s.signal_type==='risk_event'||includeEnd));
 return {trades,signals,hiddenUnassociated:!includeEnd||types.length?data.signals.filter(s=>s.trade_id==null&&s.signal_type!=='risk_event').length:0};
}

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
   Object.assign(t,classifyTrade(t));
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
   s.trade_classification=t?.trade_classification ?? null;s.exclusion_reason=t?.exclusion_reason ?? null;
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
 const [t,s,c]=await Promise.all([pool.query(`SELECT * FROM backtest_trades WHERE ${where.join(' AND ')} ORDER BY entry_time,id`,args),pool.query(`SELECT * FROM backtest_signals WHERE ${where.join(' AND ')} ORDER BY time,trade_no,event_order,id`,args),pool.query('SELECT id,config_json,input_ready,input_source_run_id,status FROM backtest_runs WHERE id=$1',[id])]);
 const run=c.rows[0];return hydrateInvalidations(pool,run ?? {id,config_json:{}},enrichResults(t.rows,s.rows,run?.config_json ?? {}));
}

export function filteredStatistics(trades:any[],signals:any[],capital:number,start:number,includeEnd:boolean){
 const matched=selectResults({trades,signals},{includeEndOfBacktest:String(includeEnd)});
 const excluded=includeEnd?[]:trades.map(t=>({...t,...classifyTrade(t)})).filter(t=>t.trade_classification!=='normal_closed');
 const selected=matched.trades.filter(t=>present(t.exit_time));
 const excludedClosed=excluded.filter(t=>t.trade_classification!=='open'&&finiteValue(t.exit_time)&&finiteValue(t.net_pnl));
 const buckets=new Map<number,number>(),reasons=new Map<string,any>();const missingPnl=selected.filter(t=>!present(t.net_pnl)).length;
 let net=0,wins=0;
 for(const t of selected){const pnl=Number(t.net_pnl ?? 0),time=Number(t.exit_time);net+=pnl;wins+=pnl>0?1:0;buckets.set(time,(buckets.get(time)??0)+pnl);
  const reason=t.exit_reason ?? 'unknown';if(!reasons.has(reason))reasons.set(reason,{reason,count:0,netPnl:0,wins:0,missingPnl:0});const r=reasons.get(reason);r.count++;r.netPnl+=pnl;r.wins+=pnl>0?1:0;r.missingPnl+=present(t.net_pnl)?0:1;
 }
 let balance=capital,peak=capital,drawdown=0,drawdownPercent=0;
 const first=trades.reduce((n,t)=>Math.min(n,Number(t.entry_time)),start);const curve=[{time:Number.isFinite(first)?first:start,equity:capital}];
 for(const [time,pnl]of [...buckets].sort((a,b)=>a[0]-b[0])){balance+=pnl;peak=Math.max(peak,balance);drawdown=Math.max(drawdown,peak-balance);drawdownPercent=Math.max(drawdownPercent,peak>0?(peak-balance)/peak*100:0);curve.push({time,equity:balance});}
 const counts=new Map<string,number>();for(const s of matched.signals)counts.set(s.signal_type,(counts.get(s.signal_type)??0)+1);
 const invalidationGroups=new Map<string,any>();
 for(const t of selected.filter(t=>t.exit_reason==='invalidation')){const code=t.invalidation_detail?.primary ?? 'unknown';if(!invalidationGroups.has(code))invalidationGroups.set(code,{code,filterType:`invalidation:${code}`,count:0,wins:0,netPnl:0,missingPnl:0});const r=invalidationGroups.get(code)!;r.count++;r.wins+=Number(t.net_pnl)>0?1:0;r.netPnl+=Number(t.net_pnl ?? 0);r.missingPnl+=present(t.net_pnl)?0:1;}
 const invalidationCount=selected.filter(t=>t.exit_reason==='invalidation').length;
 return {summary:{netPnl:missingPnl?null:net,totalNetPnl:missingPnl?null:net,unrealizedPnl:null,totalTrades:selected.length,winRate:selected.length&&!missingPnl?wins/selected.length:null,returnPercent:capital>0&&!missingPnl?net/capital*100:null,finalEquity:missingPnl?null:balance,maxDrawdown:missingPnl?null:drawdown,maxDrawdownPercent:missingPnl?null:drawdownPercent},curve:missingPnl?[]:curve,missingPnl,
  excluded:{count:excluded.length,endCount:excluded.filter(t=>t.trade_classification==='end_of_backtest').length,openCount:excluded.filter(t=>t.trade_classification==='open').length,incompleteCount:excluded.filter(t=>t.trade_classification==='incomplete').length,netPnl:excludedClosed.reduce((n,t)=>n+Number(t.net_pnl),0),knownClosedPnlCount:excludedClosed.length},
  invalidationReasons:[...invalidationGroups.values()].map(r=>({...r,netPnl:r.missingPnl?null:r.netPnl,share:r.count/invalidationCount,winRate:r.missingPnl?null:r.wins/r.count})),
  exitReasons:[...reasons.values()].map(r=>({...r,netPnl:r.missingPnl?null:r.netPnl,share:r.count/selected.length,winRate:r.missingPnl?null:r.wins/r.count})),signalCounts:[...counts].map(([type,count])=>({type,count})),unassociatedSignals:signals.filter(s=>s.trade_id==null&&s.signal_type!=='risk_event').length};
}

export async function statistics(pool:Pool,run:any,q:Record<string,string>){
 const includeEnd=includesEnd(q),data=await loadResults(pool,run.id);
 const result=filteredStatistics(data.trades,data.signals,run.config_json.executionConfig.initialCapital,run.config_json.startTime?Date.parse(run.config_json.startTime):data.trades.length?Number(data.trades[0].entry_time):new Date(run.created_at).getTime(),includeEnd);
 const original=(await pool.query('SELECT report_json FROM backtest_reports WHERE run_id=$1',[run.id])).rows[0]?.report_json ?? null;
 const originalCurve=(await pool.query('SELECT time,equity FROM (SELECT *,ROW_NUMBER() OVER(ORDER BY time) rn,COUNT(*) OVER() total FROM backtest_equity_curve WHERE run_id=$1) p WHERE rn=1 OR rn=total OR rn % GREATEST(total/2000,1)=0 ORDER BY time',[run.id])).rows;
 return {...result,summary:includeEnd?{...original,...(original?{winRate:original.totalTrades?original.winRate:null}:result.summary)}:{...result.summary,engineVersion:original?.engineVersion},curve:includeEnd?originalCurve:result.curve,original,originalCurve,partial:run.status!=='completed',openCountComplete:run.status==='completed',includeEndOfBacktest:includeEnd};
}
