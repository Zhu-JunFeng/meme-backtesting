import { BadRequestException } from "@nestjs/common";
import type { Pool } from "pg";
import type { DatasetSelection, DatasetConfig, PoolSnapshot } from "@meme/domain";
import { includesEnd, loadResults, selectResults, signalTypes } from './results.js';

export const intervals = new Set(["30s","1m","5m","15m","1h","4h","1d"]);
export function bounds(input: {startTime?:string;endTime?:string}) {
  const start = input.startTime ? Date.parse(input.startTime) : 0;
  const end = input.endTime ? Date.parse(input.endTime) : 8640000000000000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) throw new BadRequestException("时间范围无效");
  return {start,end};
}
export function validateSelection(input: DatasetSelection) {
  if (!input || !intervals.has(input.interval) || !["price","mcap"].includes(input.valueType)) throw new BadRequestException("周期或价值维度无效");
  bounds(input);
}
export function pageOf(q: Record<string,string>) {
  return {page:Math.max(1,Math.floor(Number(q.page)||1)),pageSize:Math.min(1000,Math.max(1,Math.floor(Number(q.pageSize)||20)))};
}
export function paginate<T>(items:T[],q:Record<string,string>) {
  const {page,pageSize}=pageOf(q);
  return {items:items.slice((page-1)*pageSize,page*pageSize),total:items.length,page,pageSize};
}
const cache = new Map<string,{until:number;rows:any[]}>();
export async function marketCas(pool:Pool,q:Record<string,string>) {
  const selection = {interval:q.interval ?? "30s",valueType:q.type ?? "mcap",startTime:q.startTime,endTime:q.endTime} as DatasetSelection;
  validateSelection(selection);
  const {start,end}=bounds(selection);
  const chains=(q.chains ?? "").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean);
  const args=[selection.interval,selection.valueType,start,end,chains,q.ca?.trim() || null];
  const key=JSON.stringify(args);
  let rows=cache.get(key)?.until! > Date.now() ? cache.get(key)!.rows : undefined;
  if (!rows) {
    rows=(await pool.query(`
      WITH eligible AS (
        SELECT chain,ca,MIN(open_time) AS "minTime",MAX(open_time) AS "maxTime",COUNT(DISTINCT pair_id)::int AS "availablePoolCount"
        FROM public.meme_kline WHERE interval=$1 AND type=$2 AND valid IS DISTINCT FROM false
        AND open_time BETWEEN $3 AND $4 AND (cardinality($5::text[])=0 OR chain=ANY($5))
        AND ($6::text IS NULL OR ca=$6) GROUP BY chain,ca
      ), pairs AS (
        SELECT DISTINCT k.chain,k.ca,k.pair_id FROM public.meme_kline k JOIN eligible e USING(chain,ca)
      ) SELECT e.*,COUNT(p.pair_id)::int AS "poolCount",array_agg(p.pair_id ORDER BY p.pair_id) AS "pairIds"
        FROM eligible e JOIN pairs p USING(chain,ca) GROUP BY e.chain,e.ca,e."minTime",e."maxTime",e."availablePoolCount"
        ORDER BY e.chain,e.ca`,args)).rows;
    if (cache.size>100) cache.clear();
    cache.set(key,{until:Date.now()+30000,rows});
  }
  const sorted=[...rows].sort((a,b)=>q.sort==="minTime" ? Number(a.minTime)-Number(b.minTime) : q.sort==="maxTime" ? Number(b.maxTime)-Number(a.maxTime) : (a.chain+":"+a.ca).localeCompare(b.chain+":"+b.ca));
  return paginate(sorted,q);
}
export async function resolveDataset(pool:Pool,input:DatasetSelection):Promise<DatasetConfig> {
  validateSelection(input);
  const refs=input.cas?.length ? input.cas : input.symbols;
  if (!Array.isArray(refs) || !refs.length || refs.length>10000 || refs.some(s=>!s || typeof s.chain!=="string" || !s.chain.trim() || typeof s.ca!=="string" || !s.ca.trim())) throw new BadRequestException("请选择有效的 CA（最多 10000 个）");
  const {start,end}=bounds(input);
  const selected=[...new Map(refs.map(s=>{const r={...s,chain:s.chain.trim().toLowerCase(),ca:s.ca.trim()};return [JSON.stringify(r),r]})).values()];
  const pools:PoolSnapshot[]=(await pool.query(`
    WITH selected AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS s(chain text,ca text,"pairId" text)),
    pairs AS (SELECT DISTINCT k.chain,k.ca,k.pair_id FROM public.meme_kline k JOIN selected s
      ON k.chain=s.chain AND k.ca=s.ca AND ($6::boolean OR k.pair_id=s."pairId"))
    SELECT p.chain,p.ca,p.pair_id AS "pairId",r.start AS "startTime",r.finish AS "endTime",r.start IS NULL AS "noData"
    FROM pairs p LEFT JOIN LATERAL (
      SELECT MIN(open_time) AS start,MAX(open_time) AS finish FROM public.meme_kline k
      WHERE k.chain=p.chain AND k.ca=p.ca AND k.pair_id=p.pair_id AND k.interval=$2 AND k.type=$3
      AND k.valid IS DISTINCT FROM false AND k.open_time BETWEEN $4 AND $5
    ) r ON true ORDER BY p.chain,p.ca,p.pair_id`,[JSON.stringify(selected),input.interval,input.valueType,start,end,!!input.cas?.length])).rows.map(r=>({...r,startTime:r.startTime===null?null:Number(r.startTime),endTime:r.endTime===null?null:Number(r.endTime)}));
  for (const ref of selected) if (!pools.some(p=>p.chain===ref.chain && p.ca===ref.ca && !p.noData)) throw new BadRequestException(`CA ${ref.chain}/${ref.ca} 在所选范围没有有效 K 线，请重新筛选`);
  return {symbols:pools.map(({chain,ca,pairId})=>({chain,ca,pairId})),pools,interval:input.interval,valueType:input.valueType,startTime:input.startTime || undefined,endTime:input.endTime || undefined,selection:structuredClone(input)};
}
export function datasetCounts(dataset:DatasetConfig) {
  return {caCount:new Set(dataset.symbols.map(s=>s.chain+":"+s.ca)).size,poolCount:dataset.symbols.length,availablePoolCount:dataset.pools?.filter(p=>!p.noData).length ?? dataset.symbols.length,noDataPoolCount:dataset.pools?.filter(p=>p.noData).length ?? 0};
}
export async function resultRows(pool:Pool,id:string,kind:"trades"|"signals",q:Record<string,string>) {
  const data=selectResults(await loadResults(pool,id,q),q),time=kind==='trades'?'entry_time':'time';
  for(const param of ['from','to'])if(q[param]&&!Number.isFinite(Number(q[param])))throw new BadRequestException('事件时间无效');
  // Enrich before paging/time filtering, so numbers remain stable across chart windows.
  const rows=data[kind].filter(r=>(!q.from||Number(r[time])>=Number(q.from))&&(!q.to||Number(r[time])<=Number(q.to)));
  return !q.page&&!q.pageSize?rows:{...paginate(rows,q),hiddenUnassociated:data.hiddenUnassociated};
}
export async function runCas(pool:Pool,run:any,q:Record<string,string>,detail=false) {
  const includeEnd=includesEnd(q),types=signalTypes(q);
  const config=run.config_json as DatasetConfig;
  const report=(await pool.query("SELECT report_json FROM backtest_reports WHERE run_id=$1",[run.id])).rows[0]?.report_json;
  let stats:any[];
  if(types.length || !includeEnd){
    const data=selectResults(await loadResults(pool,run.id),q),map=new Map<string,any>();
    for(const t of data.trades){const key=JSON.stringify([t.chain,t.ca,t.pair_id]);if(!map.has(key))map.set(key,{chain:t.chain,ca:t.ca,pair_id:t.pair_id,trades:0,entries:0,missingPnl:0,realized:0,costs:0});const s=map.get(key);s.entries++;if(t.exit_time!=null){s.trades++;s.missingPnl+=t.net_pnl==null?1:0;s.realized+=Number(t.net_pnl ?? 0);}s.costs+=Number(t.fees??0)+Number(t.slippage_cost??0)+Number(t.tax_cost??0);}
    stats=[...map.values()];
  }else stats=(await pool.query(`SELECT chain,ca,pair_id,COUNT(*) FILTER(WHERE exit_time IS NOT NULL)::int AS trades,COUNT(*)::int AS entries,COUNT(*) FILTER(WHERE exit_time IS NOT NULL AND net_pnl IS NULL)::int AS "missingPnl",
    COALESCE(SUM(net_pnl),0) AS realized,COALESCE(SUM(fees+slippage_cost+tax_cost),0) AS costs
    FROM backtest_trades WHERE run_id=$1 AND ($2::boolean OR exit_reason IS DISTINCT FROM 'end_of_backtest') GROUP BY chain,ca,pair_id`,[run.id,includeEnd])).rows;
  const pairs=(config.pools ?? config.symbols ?? []).map(s=>{
    const snapshot="noData" in s ? s as PoolSnapshot : undefined;
    const stat=stats.find(r=>r.chain===s.chain && r.ca===s.ca && r.pair_id===s.pairId);
    const open=report?.openPositions?.find((r:any)=>r.symbol.chain===s.chain && r.symbol.ca===s.ca && r.symbol.pairId===s.pairId);
    const legacy=types.length>0 || !includeEnd || (report && !report.engineVersion);
    return {...s,startTime:snapshot?.startTime ?? (config.startTime ? Date.parse(config.startTime):null),endTime:snapshot?.endTime ?? (config.endTime ? Date.parse(config.endTime):null),
      noData:snapshot?.noData ?? null,trades:stat?.trades ?? 0,entries:stat?.entries ?? 0,
      realizedPnl:stat?.missingPnl>0?null:Number(stat?.realized ?? 0),unrealizedPnl:legacy ? null : Number(open?.netPnl ?? 0),fees:Number(stat?.costs ?? 0)};
  });
  const map=new Map<string,any>();
  for(const p of pairs.filter(p=>!types.length||p.entries>0)) {
    const key=p.chain+":"+p.ca;
    if(!map.has(key)) map.set(key,{chain:p.chain,ca:p.ca,pools:[],poolCount:0,noDataPoolCount:0,trades:0,entries:0,realizedPnl:0,unrealizedPnl:types.length || !includeEnd || (report && !report.engineVersion) ? null:0,fees:0});
    const row=map.get(key);row.pools.push(p);row.poolCount++;row.noDataPoolCount+=p.noData?1:0;
    row.trades+=p.trades;row.entries+=p.entries;row.realizedPnl=row.realizedPnl===null||p.realizedPnl===null?null:row.realizedPnl+p.realizedPnl;row.fees+=p.fees;
    if(row.unrealizedPnl!==null) row.unrealizedPnl+=p.unrealizedPnl ?? 0;
  }
  const all=[...map.values()];
  if(detail) return all.find(r=>r.chain===q.chain && r.ca===q.ca) ?? null;
  const rows=all.filter(r=>(!q.chain || r.chain===q.chain) && (!q.ca || r.ca.includes(q.ca)));
  rows.sort((a,b)=>['pnl_asc','pnl_desc'].includes(q.sort)&&(a.realizedPnl===null||b.realizedPnl===null)?Number(a.realizedPnl===null)-Number(b.realizedPnl===null):q.sort==="pnl_asc"?a.realizedPnl-b.realizedPnl:q.sort==="pnl_desc"?b.realizedPnl-a.realizedPnl:(a.chain+":"+a.ca).localeCompare(b.chain+":"+b.ca));
  return {...paginate(rows,q),summary:{...datasetCounts(config),tradedCaCount:all.filter(r=>r.entries>0).length,untradedCaCount:all.filter(r=>!r.entries).length,realizedPnl:all.some(r=>r.realizedPnl===null)?null:all.reduce((s,r)=>s+r.realizedPnl,0)}};
}
