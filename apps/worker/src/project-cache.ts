import {Decimal} from 'decimal.js';
import type {Project} from './meme-market.js';
import {resolveLivePool} from './live-input.js';

const D=Decimal.clone({precision:240});
const decimal=(v:unknown):v is string=>typeof v==='string'&&v.length<=100&&/^\d+(\.\d+)?$/.test(v);
export const normalizeProject=(p:Project):Project=>({chain:p.chain.trim().toLowerCase(),ca:p.chain.trim().toLowerCase()==='sol'?p.ca.trim():p.ca.trim().toLowerCase()});
export const cacheKey=(p:Project)=>{const n=normalizeProject(p);return `meme:project-info:v1:${n.chain}:${n.ca}`;};
export type Supply={original:string;unit:'raw'|'tokens';decimals:number|null;tokens:string;fetchedAt:number};
export type ProjectInfo={chain:string;ca:string;pairId:string;dexId:string;marketCap?:number;createdAt?:number;fetchedAt:number;supply?:Supply};
type RecordState={version:1;attempts:number;status:'ready'|'failed';nextRetryAt:number;error?:string;info?:ProjectInfo};
export type CacheStore={get:(key:string)=>Promise<string|null>;set:(key:string,value:string)=>Promise<unknown>};

export function normalizedSupply(value:unknown,unit:unknown,decimals:unknown,fetchedAt:number):Supply{
 if(!decimal(value)||new D(value).lte(0))throw new Error('供应量缺失或非法');
 if(unit!=='raw'&&unit!=='tokens')throw new Error('供应量单位无法确认');
 if(unit==='tokens')return {original:value,unit,decimals:null,tokens:new D(value).toFixed(),fetchedAt};
 const digits=typeof decimals==='string'&&/^\d+$/.test(decimals)?Number(decimals):decimals;
 if(!/^\d+$/.test(value)||!Number.isInteger(digits)||Number(digits)<0||Number(digits)>255)throw new Error('原始供应量或代币精度非法');
 return {original:value,unit,decimals:Number(digits),tokens:new D(value).div(new D(10).pow(Number(digits))).toFixed(),fetchedAt};
}
export function projectInfo(item:any,p:Project,now:number):ProjectInfo{
 const n=normalizeProject(p);
 if(String(item?.chain??'').trim().toLowerCase()!==n.chain||normalizeProject({chain:n.chain,ca:String(item?.token_address??'')}).ca!==n.ca)throw new Error('lookup 链或 CA 不匹配');
 const pool=resolveLivePool(item,true);if(!pool)throw new Error('lookup 缺少主交易池');
 const meta=item.project_meta??{};
 // Contract: project_meta.total_supply is raw unless its unit is explicitly declared.
 const unit=meta.total_supply_unit??'raw';
 return {...n,...pool,createdAt:projectCreatedAt(item),fetchedAt:now,supply:normalizedSupply(meta.total_supply,unit,meta.decimals,now)};
}
export function projectCreatedAt(item:any):number|undefined {
 for(const value of [item?.token_create_time,item?.project_meta?.create_time]){
  if(value==null||value==='')continue;
  const n=Number(value),t=Number.isFinite(n)?(n<1e12?n*1000:n):Date.parse(String(value));
  if(Number.isSafeInteger(t)&&t>0&&t<=Date.now())return t;
 }
}
export type MarketCapBasis={source:'ws'|'price_supply';value:string;supply?:Supply};
export function resolveMarketCap(raw:any,info?:ProjectInfo):MarketCapBasis|undefined{
 if(decimal(raw.market_cap_usd)&&new D(raw.market_cap_usd).gt(0)&&Number.isFinite(Number(raw.market_cap_usd)))return {source:'ws',value:raw.market_cap_usd};
 if(!info?.supply||!decimal(raw.price_usd)||new D(raw.price_usd).lte(0))return;
 const value=new D(raw.price_usd).mul(info.supply.tokens).toFixed();
 if(!Number.isFinite(Number(value))||Number(value)<=0)return;
 return {source:'price_supply',value,supply:info.supply};
}

/** Persistent success/attempt ledger plus single-flight in-process reads. Never expire successful supply. */
export class ProjectCache {
 private memory=new Map<string,RecordState>();private pending=new Map<string,Promise<ProjectInfo>>();
 private freshPending=new Map<string,Promise<ProjectInfo>>();
 storageStatus:'redis'|'memory'='memory';
 constructor(private readonly store?:CacheStore,private readonly request:typeof fetch=fetch,private readonly now=()=>Date.now()){}
 peek(p:Project){return this.memory.get(cacheKey(p))?.status==='ready'?this.memory.get(cacheKey(p))!.info:undefined;}
 status(p:Project){const r=this.memory.get(cacheKey(p));return r?{status:r.status,attempts:r.attempts,nextRetryAt:r.nextRetryAt,error:r.error}:undefined;}
 /** Dynamic cap/creation metadata cannot use the permanent supply cache. */
 fresh(p:Project):Promise<ProjectInfo>{
  const key=cacheKey(p),pending=this.freshPending.get(key);if(pending)return pending;
  const task=this.loadFresh(p).finally(()=>this.freshPending.delete(key));this.freshPending.set(key,task);return task;
 }
 private async loadFresh(p:Project):Promise<ProjectInfo>{
  const n=normalizeProject(p),key=cacheKey(p),prior=await this.read(key);
  if(prior?.info&&this.now()-prior.info.fetchedAt<60000)return prior.info;
  const r=await this.request('https://app.memeinfo.net/api/projects/lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caList:[n.ca],symbolList:['']}),signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error(`lookup HTTP ${r.status}`);const data=await r.json() as any;
  const item=(data?.data?.caListTokenList??[]).find((x:any)=>String(x.chain??'').trim().toLowerCase()===n.chain&&normalizeProject({chain:n.chain,ca:String(x.token_address??'')}).ca===n.ca);
  const pool=resolveLivePool(item,true);if(!pool)throw new Error('lookup 缺少匹配主池');
  let supply=prior?.info?.supply;try{supply=normalizedSupply(item.project_meta?.total_supply,item.project_meta?.total_supply_unit??'raw',item.project_meta?.decimals,this.now());}catch{/* original WS market cap remains usable; derived cap will fail closed */}
  const info={...n,...pool,createdAt:projectCreatedAt(item),fetchedAt:this.now(),supply};
  await this.save(key,{version:1,status:'ready',attempts:0,nextRetryAt:0,info});return info;
 }
 get(p:Project):Promise<ProjectInfo>{
  const key=cacheKey(p),existing=this.pending.get(key);if(existing)return existing;
  const task=this.load(normalizeProject(p)).finally(()=>this.pending.delete(key));this.pending.set(key,task);return task;
 }
 private async read(key:string){if(this.memory.has(key))return this.memory.get(key);
  if(this.store)try{const value=await this.store.get(key);this.storageStatus='redis';if(value){const r=JSON.parse(value) as RecordState;if(r.version===1&&Number.isInteger(r.attempts)&&r.attempts>=0&&r.attempts<=3&&['ready','failed'].includes(r.status)){this.memory.set(key,r);return r;}}}catch{this.storageStatus='memory';}
 }
 private async save(key:string,r:RecordState){this.memory.set(key,r);if(this.store)try{await this.store.set(key,JSON.stringify(r));this.storageStatus='redis';}catch{this.storageStatus='memory';}}
 private async load(p:Project){
  const key=cacheKey(p),prior=await this.read(key);
  if(prior?.status==='ready'&&prior.info){return prior.info;}
  if(prior&&(prior.attempts>=3||prior.nextRetryAt>this.now()))throw new Error(prior.error??'项目资料查询退避中');
  const attempts=(prior?.attempts??0)+1;
  // Persist attempt before network I/O; restart cannot reset the three-attempt budget.
  await this.save(key,{version:1,attempts,status:'failed',nextRetryAt:this.now()+15_000,error:'项目资料请求尚未完成'});
  try{
   const r=await this.request('https://app.memeinfo.net/api/projects/lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caList:[p.ca],symbolList:['']}),signal:AbortSignal.timeout(10_000)});
   if(!r.ok)throw new Error(`lookup HTTP ${r.status}`);const data=await r.json() as any;
   const item=(data?.data?.caListTokenList??[]).find((x:any)=>String(x.chain??'').trim().toLowerCase()===p.chain&&normalizeProject({chain:p.chain,ca:String(x.token_address??'')}).ca===p.ca);
   const info=projectInfo(item,p,this.now());await this.save(key,{version:1,attempts,status:'ready',nextRetryAt:0,info});return info;
  }catch(e){const error=String(e).slice(0,250);await this.save(key,{version:1,attempts,status:'failed',nextRetryAt:this.now()+5000*2**(attempts-1),error});throw new Error(error);}
 }
}
