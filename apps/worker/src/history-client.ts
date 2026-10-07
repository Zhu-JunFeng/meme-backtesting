import {Decimal} from 'decimal.js';

export type HistoryRequest={chain:string;pair:string;interval:'30s'|'1m';type:'price'|'mcap';from:number;to:number};
export type HistoryRow={time:number;open:string;high:string;low:string;close:string;volume:string};
export type HistoryResult={rows:HistoryRow[];traceId?:string;endpoint:string};
export class HistoryError extends Error {
 constructor(message:string,readonly retryable=false,readonly status?:number,readonly code?:string,readonly traceId?:string){
  super(`${message}${status?` · HTTP ${status}`:''}${code?` · code ${code}`:''}${traceId?` · traceId ${traceId}`:''}`);
 }
}
/** Decimal strings survive validation and PostgreSQL insertion without display rounding. */
export function parseHistory(data:any,request:HistoryRequest,endpoint:string):HistoryResult{
 const traceId=typeof data?.traceId==='string'?data.traceId:undefined;
 if(data?.success!==true||data?.code!=='200')throw new HistoryError(String(data?.message??'历史补数业务响应失败'),false,undefined,String(data?.code??'unknown'),traceId);
 const d=data.data,step=request.interval==='30s'?30_000:60_000;
 if(d?.chain!==request.chain||d?.pair_address!==request.pair||d?.interval!==request.interval||d?.value_type!==(request.type==='mcap'?'market_cap':'price')||!Array.isArray(d?.items))throw new HistoryError('历史补数响应链／池／周期／维度不匹配',false,undefined,undefined,traceId);
 const rows=new Map<number,HistoryRow>();
 for(const item of d.items){
  const time=item?.start_time;
  if(!Number.isSafeInteger(time)||time<=0||time%step!==0)throw new HistoryError('历史 K 线时间非法',false,undefined,undefined,traceId);
  if(time<request.from||time+step>request.to)continue;
  const values:Record<string,Decimal>={};
  for(const field of ['open','high','low','close','volume'] as const){
   const raw=item[field];
   if(typeof raw!=='string'||raw.length>512||!/^\d+(\.\d+)?$/.test(raw))throw new HistoryError(`历史 K 线 ${field} 非法`,false,undefined,undefined,traceId);
   const v=new Decimal(raw);values[field]=v;
   if(!v.isFinite()||!Number.isFinite(v.toNumber())||(field==='volume'?v.isNegative():v.lte(0)||v.toNumber()<=0))throw new HistoryError(`历史 K 线 ${field} 超出有效范围`,false,undefined,undefined,traceId);
  }
  if(values.low.gt(Decimal.min(values.open,values.close))||values.high.lt(Decimal.max(values.open,values.close))||values.low.gt(values.high))throw new HistoryError(`历史 K 线 OHLC 关系非法：${new Date(time).toISOString()}，拒绝本窗口`,false,undefined,undefined,traceId);
  const row={time,open:item.open,high:item.high,low:item.low,close:item.close,volume:item.volume};
  const previous=rows.get(time);
  if(previous&&(['open','high','low','close','volume'] as const).some(k=>!new Decimal(previous[k]).eq(row[k])))throw new HistoryError(`历史 K 线重复时间数据冲突：${time}`,false,undefined,undefined,traceId);
  rows.set(time,row);
 }
 return {rows:[...rows.values()].sort((a,b)=>a.time-b.time),traceId,endpoint};
}

/** A worker-wide two-request limiter and single-flight cache; never runs on the live event queue. */
export class HistoryClient {
 private active=0;private waiting:Array<()=>void>=[];private inFlight=new Map<string,Promise<HistoryResult>>();
 private controller=new AbortController();
 constructor(readonly endpoint=process.env.MEMEINFO_HISTORY_URL??'https://app.memeinfo.net/api/project-overview/xxyy-klines',private readonly transport:typeof fetch=fetch,private readonly delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))){}
 close(){this.controller.abort();}
 get(request:HistoryRequest):Promise<HistoryResult>{
  const step=request.interval==='30s'?30_000:60_000;
  if(!request.pair||!Number.isSafeInteger(request.from)||request.from<=0||request.from%step||!Number.isSafeInteger(request.to)||request.to%step||request.to<=request.from||request.to-request.from>step*5000)return Promise.reject(new HistoryError('历史补数请求范围非法'));
  const key=JSON.stringify(request),existing=this.inFlight.get(key);if(existing)return existing;
  const operation=this.perform(request).finally(()=>this.inFlight.delete(key));this.inFlight.set(key,operation);return operation;
 }
 private async limited<T>(fn:()=>Promise<T>):Promise<T>{
  if(this.active>=2)await new Promise<void>(resolve=>this.waiting.push(resolve));else this.active++;
  try{if(this.controller.signal.aborted)throw new HistoryError('历史补数已停止');return await fn();}
  finally{const next=this.waiting.shift();if(next)next();else this.active--;}
 }
 private async perform(request:HistoryRequest){
  for(let attempt=0;;attempt++){
   try{return await this.limited(async()=>{
    const step=request.interval==='30s'?30_000:60_000;
    const response=await this.transport(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chain:request.chain,pair_address:request.pair,interval:request.interval,value_type:request.type==='mcap'?'market_cap':'price',from_time:request.from,to_time:request.to,count_back:(request.to-request.from)/step}),signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(30_000)])});
    let data:any;try{data=await response.json();}catch{throw new HistoryError('历史补数返回非 JSON 内容',response.status===429||response.status>=500,response.status);}
    if(!response.ok)throw new HistoryError(String(data?.message??'历史补数请求失败'),response.status===429||response.status>=500,response.status,String(data?.code??'unknown'),typeof data?.traceId==='string'?data.traceId:undefined);
    return parseHistory(data,request,this.endpoint);
   });}catch(error){
    const failure=error instanceof HistoryError?error:new HistoryError(`历史补数网络／超时错误：${String(error).slice(0,160)}`,true);
    if(this.controller.signal.aborted||!failure.retryable||attempt>=2)throw failure;
    await this.delay(attempt===0?1000:3000);
   }
  }
 }
}
