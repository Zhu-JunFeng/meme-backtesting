import {createHash} from 'node:crypto';
import {MemeMarketFeed,parseMemeTrade,projectKey,type Project} from './meme-market.js';
import {ProjectCache,resolveMarketCap} from './project-cache.js';
import {HistoryClient,type HistoryResult} from './history-client.js';
import {Redis} from 'ioredis';
import {redisConnection} from '@meme/runtime';
import WebSocket from 'ws';
import type {Pool,PoolClient} from 'pg';
import {LiveCandleAggregator,LiveEvaluator,detectImpulse,validCandle,type ClosedMarketBar,type LiveDecision,type MarketTrade} from '@meme/engine';
import type {Candle,StrategyConfig} from '@meme/domain';
import {selectedLiveSources,selectedProjectSources,qualifiesSource,effectiveExitCap,type ProjectSources,type ProjectProvider} from '@meme/domain';
import {parseProjectSignal,type ProjectSignal} from './live-input.js';
import {ProjectDiscovery,type Discovery} from './project-discovery.js';

type Run={id:string;mode:'paper'|'live';chain:string;signal_source:string;project_sources?:ProjectSources;interval:'30s'|'1m';value_type:'price'|'mcap';status:string;execution_hold_reason:string|null;strategy_json:StrategyConfig;cash:string;realized_pnl:string;wallet_address:string|null;risk_json:any;started_at:Date;execution_version:string;execution_switched_at:Date|null};
type Watch={run_id:string;chain:string;ca:string;pair_id:string;dex_id:string|null;signal_time:string;state_json:any;last_candle_time:string|null;status:string;current_mcap:string|null;last_trade_at:string|null;matched_sources?:ProjectProvider[];exit_market_cap?:string;exit_only?:boolean};
type Context={run:Run;watch:Watch;evaluator:LiveEvaluator;ready:boolean;nextRecoveryAt:number;noOrdersBefore:number};
const watchKey=(r:string,c:string,a:string)=>`${r}:${c}:${a}`;
const pairKey=(c:string,p:string)=>`${c}:${p.toLowerCase()}`;
export const LIVE_CA_LIMIT=20,MIN_MARKET_CAP=50_000;
export const LIVE_EXECUTION_VERSION='closed-bar-v3';
export function simulatedBarPrice(valueType:'price'|'mcap',value:number,bar:ClosedMarketBar,price:ClosedMarketBar|undefined){
 if(!price || !validCandle(price.candle) || !validCandle(bar.candle) || price.type!=='price' || price.interval!==bar.interval || price.candle.time!==bar.candle.time || price.candle.closeTime!==bar.candle.closeTime || price.symbol.ca!==bar.symbol.ca || price.symbol.pairId!==bar.symbol.pairId || price.symbol.chain!==bar.symbol.chain)return;
 if(valueType==='mcap' && (!bar.closeTradeId || !Number.isSafeInteger(bar.closeTradeTime) || price.closeTradeId!==bar.closeTradeId || price.closeTradeTime!==bar.closeTradeTime || !!price.candle.synthetic!==!!bar.candle.synthetic))return;
 const result=valueType==='price'?value:price.candle.close*value/bar.candle.close;
 return Number.isFinite(result)&&result>0?result:undefined;
}
export const eligibleMarketCap=(value:unknown)=>Number.isFinite(Number(value))&&value!==null&&value!==undefined&&Number(value)>=MIN_MARKET_CAP;
export const canMonitor=(active:number,existing:boolean)=>existing||active<LIVE_CA_LIMIT;
export function* backfillWindows(from:number,to:number,step:number):Generator<{from:number;to:number}>{
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||!Number.isSafeInteger(step)||step<=0||from%step!==0||to%step!==0||to<from)throw new Error('补行情时间范围无效');
 for(let start=from;start<to;start+=step*5000)yield {from:start,to:Math.min(to,start+step*5000)};
}
export function localWarmupBars(config:StrategyConfig):number{
 const periods:number[]=[];
 const visit=(value:unknown)=>{
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach(visit);return;}
  const item=value as Record<string,unknown>;
  for(const key of ['period','lookbackBars'])if(typeof item[key]==='number'&&Number.isFinite(item[key]))periods.push(item[key]);
  if(Array.isArray(item.conditions))visit(item.conditions);
 };
 visit(config.entryConditionGroup);visit(config.addConditionGroup);visit(config.invalidationConditionGroup);
 const impulse=config.impulseCondition;
 return Math.max(impulse.lookbackBars+impulse.leftBars+impulse.rightBars+1,...periods.map(period=>period+2),1);
}
export const acceptsNewSignal=(run:{signal_source:string;signal_sources?:string[]|null;started_at:Date|string},signal:ProjectSignal)=>
 selectedLiveSources(run).includes(signal.source as any)&&signal.time>new Date(run.started_at).getTime();
export function acceptsDiscovery(run:any,signal:Discovery){
 const rule=selectedProjectSources(run)[signal.provider];
 const after=Math.max(new Date(run.started_at).getTime(),Number(run.source_activated_at?.[signal.provider]??0));
 if(!rule.enabled||signal.time<=after)return false;
 if(signal.provider==='wallet'&&Number(signal.identity.transactionTime)<=after)return false;
 return signal.provider!=='memeinfo'||rule.signalSources!.includes(signal.source as any);
}
const redact=(error:unknown)=>String(error).replace(/Bearer\s+[^\s]+/gi,'Bearer [redacted]').slice(0,300);
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/** XXYY does not document a client order id. Unknown outcomes are deliberately never retried. */
export class XxyyTradeClient {
 private nextAt=0;
 private requests=Promise.resolve();
 constructor(private readonly key:string,private readonly base='https://www.xxyy.io'){}
 private request(path:string,init:RequestInit={}){
  const operation=this.requests.then(()=>this.performRequest(path,init));
  this.requests=operation.then(()=>undefined,()=>undefined);
  return operation;
 }
 private async performRequest(path:string,init:RequestInit={}){
  const delay=this.nextAt-Date.now();if(delay>0)await wait(delay);this.nextAt=Date.now()+1100;
  const response=await fetch(this.base+path,{...init,headers:{Authorization:`Bearer ${this.key}`,'Content-Type':'application/json',...init.headers},signal:AbortSignal.timeout(12_000)});
  if(!response.ok)throw new Error(`XXYY HTTP ${response.status}`);
  const data=await response.json() as any;if(data.code!==200||data.success===false)throw new Error(`XXYY API ${data.code??'unknown'}`);
  return data.data;
 }
 async swap(body:{chain:'sol'|'bsc';walletAddress:string;tokenAddress:string;isBuy:boolean;amount:number;tip:number;slippage:number}){
  const data=await this.request('/api/trade/open/api/swap',{method:'POST',body:JSON.stringify(body)});
  if(typeof data?.txId!=='string'||!data.txId)throw new Error('XXYY 下单响应缺少 txId，结果未知');
  return data.txId as string;
 }
 async query(txId:string){return this.request(`/api/trade/open/api/trade?txId=${encodeURIComponent(txId)}`);}
 async walletInfo(chain:'sol'|'bsc',walletAddress:string,tokenAddress?:string){
  const query=new URLSearchParams({chain,walletAddress});if(tokenAddress)query.set('tokenAddress',tokenAddress);
  return this.request(`/api/trade/open/api/wallet/info?${query}`);
 }
}

export class LiveService {
 private closedBars:ClosedMarketBar[]=[];
 private readonly aggregator=new LiveCandleAggregator(bar=>this.closedBars.push(bar));
 private executionClient?:PoolClient;
 private get db(){return this.executionClient??this.pool;}
 private submissions:Array<{ctx:Context;id:string;decision:LiveDecision;amount:number}>=[];
 private readonly watches=new Map<string,Context>();
 private readonly marketSessions=new Map<string,string>();
 private readonly marketEpochs=new Map<string,number>();
 private readonly marketInputAfter=new Map<string,number>();
 private pendingMarket=0;
 private readonly quality={invalid:0,gaps:0,overflow:0,derivedMcap:0,wsMcap:0};
 private readonly projectRedis=new Redis({...redisConnection(),lazyConnect:true,connectTimeout:800,commandTimeout:800,maxRetriesPerRequest:1,enableOfflineQueue:false,retryStrategy:()=>null});
 private readonly projects=new ProjectCache(this.projectRedis);
 private readonly projectLoading=new Set<string>();
 private readonly supplyBlocked=new Set<string>();
 private readonly projectTrades=new Map<string,Array<{raw:any;session:string;epoch:number|undefined}>>();
 private readonly latestCaps=new Map<string,{value:number;time:number;pairId:string}>();
 private readonly signalRetries=new Map<string,ReturnType<typeof setTimeout>>();
 private readonly market=new MemeMarketFeed({
  ready:(projects,session)=>{for(const p of projects){this.marketSessions.set(projectKey(p),session);this.marketEpochs.set(projectKey(p),Date.now());}this.enqueue(async()=>{for(const ctx of this.matchProjects(projects)){this.connected.add(pairKey(ctx.watch.chain,ctx.watch.pair_id));ctx.noOrdersBefore=Date.now();ctx.nextRecoveryAt=0;await this.markRecovering(ctx,'协议 2 订阅已确认，正在预热／补数');}});},
  interrupted:(projects,reason)=>this.interruptMarket(projects,reason),
  removed:projects=>{for(const p of projects){this.marketSessions.delete(projectKey(p));this.marketEpochs.delete(projectKey(p));this.marketInputAfter.delete(projectKey(p));this.projectTrades.delete(projectKey(p));}},
  trade:(raw,session)=>this.receiveTrade(raw,session)
 });
 private prepareProject(p:Project){
  const key=projectKey(p);if(this.stopped||this.projectLoading.has(key)||this.projects.peek(p))return;
  const state=this.projects.status(p);if(state&&(state.attempts>=3||state.nextRetryAt>Date.now()))return;
  this.projectLoading.add(key);
  void this.projects.get(p).then(()=>{
   if(this.stopped)return;
   const waiting=this.projectTrades.get(key)??[];this.projectTrades.delete(key);this.supplyBlocked.delete(key);
   waiting.sort((a,b)=>a.raw.trade_time-b.raw.trade_time||String(a.raw.event_id).localeCompare(String(b.raw.event_id)));
   for(const item of waiting)this.receiveTrade(item.raw,item.session,item.epoch);
  }).catch(e=>{if(!this.stopped){if(this.projects.status(p)?.attempts===3)this.projectTrades.delete(key);this.enqueue(async()=>{for(const ctx of this.matchProjects([p]))await this.markRecovering(ctx,`供应量资料不可用：${redact(e)}`);});}}).finally(()=>this.projectLoading.delete(key));
 }
 private blockSupply(p:Project,reason:string){
  const key=projectKey(p);if(this.supplyBlocked.has(key))return;this.supplyBlocked.add(key);
  // The already-open bucket may contain trades discarded before metadata arrived.
  // Resume aggregation only at the next complete minute, for both 30s and 1m.
  this.marketInputAfter.set(key,Math.ceil(Date.now()/60_000)*60_000);
  for(const ctx of this.matchProjects([p])){ctx.ready=false;ctx.noOrdersBefore=Date.now();this.confirmedFeeds.delete(pairKey(ctx.watch.chain,ctx.watch.pair_id));this.aggregator.discardPair(ctx.watch.chain,ctx.watch.pair_id);}
  this.closedBars=this.closedBars.filter(b=>projectKey(b.symbol)!==key);
  this.enqueue(async()=>{for(const ctx of this.matchProjects([p]))await this.markRecovering(ctx,reason);});
 }
 private receiveTrade(raw:any,session:string,originalEpoch?:number){
   if(this.stopped)return;
   if(this.marketSessions.get(projectKey(raw))!==session)return;
   const epoch=this.marketEpochs.get(projectKey(raw));if(originalEpoch!==undefined&&originalEpoch!==epoch)return;
   const contexts=this.matchProjects([raw]).filter(c=>!raw.pair_id||c.watch.pair_id===raw.pair_id);if(!contexts.length)return;
   const trade=parseMemeTrade(raw);if(!trade){this.quality.invalid++;this.market.resetProjects([raw],'成交字段缺失／非法，受影响时间桶不可用于策略');return;}
   const info=this.projects.peek(raw),basis=resolveMarketCap(raw,info);
   if(!basis&&info&&contexts.some(c=>c.run.value_type==='mcap')){this.quality.invalid++;this.market.resetProjects([raw],'缓存供应量无法为本笔成交计算有限正数市值，丢弃受影响桶并重新预热');return;}
   if((!basis||this.supplyBlocked.has(projectKey(raw)))&&contexts.some(c=>c.run.value_type==='mcap')){
    const key=projectKey(raw),waiting=this.projectTrades.get(key)??[];
    this.blockSupply(raw,'正在获取供应量，暂缓市值策略判断');
    if(!this.projectLoading.has(key)&&this.projects.status(raw)?.attempts===3&&this.projects.status(raw)?.status==='failed')return;
    const total=[...this.projectTrades.values()].reduce((sum,x)=>sum+x.length,0);
    if(waiting.length>=256||total+this.pendingMarket>=2000){this.quality.overflow++;this.projectTrades.delete(key);this.market.resetProjects([raw],'供应量等待队列溢出，受影响时间桶丢弃并重新预热');return;}
    waiting.push({raw,session,epoch});this.projectTrades.set(key,waiting);this.prepareProject(raw);return;
   }
   if(basis){trade.mcap=Number(basis.value);trade.marketCapBasis=basis;this.quality[basis.source==='ws'?'wsMcap':'derivedMcap']++;}
   if(this.pendingMarket>=2000){this.quality.overflow++;this.market.resetProjects([raw],'本地成交处理队列溢出，暂停判断并补数');return;}
   this.pendingMarket++;
   this.enqueue(async()=>{try{
    if(this.marketSessions.get(projectKey(raw))!==session||this.marketEpochs.get(projectKey(raw))!==epoch)return;
    await this.onTrade(trade);
   }finally{this.pendingMarket--;}});
 }
 private matchProjects(projects:Project[]){const keys=new Set(projects.map(projectKey));return [...this.watches.values()].filter(c=>keys.has(projectKey(c.watch)));}
 private interruptMarket(projects:Project[],reason:string){
  if(!projects.length)return;
  this.quality.gaps++;
  // Fence queued decisions immediately, before any asynchronous database work.
  for(const p of projects){this.marketEpochs.set(projectKey(p),Date.now());this.marketSessions.delete(projectKey(p));this.projectTrades.delete(projectKey(p));this.supplyBlocked.delete(projectKey(p));}
  for(const ctx of this.matchProjects(projects)){ctx.ready=false;ctx.noOrdersBefore=Date.now();this.connected.delete(pairKey(ctx.watch.chain,ctx.watch.pair_id));this.confirmedFeeds.delete(pairKey(ctx.watch.chain,ctx.watch.pair_id));this.aggregator.discardPair(ctx.watch.chain,ctx.watch.pair_id);}
  this.closedBars=this.closedBars.filter(b=>!projects.some(p=>p.chain===b.symbol.chain&&p.ca===b.symbol.ca));
  this.enqueue(async()=>{for(const ctx of this.matchProjects(projects)){await this.markRecovering(ctx,reason);this.bump(ctx.run.id,'reconnect');if(ctx.run.mode==='paper')await this.pool.query("UPDATE live_orders SET status='cancelled',updated_at=now() WHERE run_id=$1 AND chain=$2 AND ca=$3 AND status='pending'",[ctx.run.id,ctx.watch.chain,ctx.watch.ca]);}});
 }
 private readonly connected=new Set<string>();
 private readonly confirmedFeeds=new Set<string>();
 private readonly telemetry=new Map<string,{late:number;dropped:number;closed:number;tooOld:number;reconnect:number;lastTradeAt:number}>();
 private readonly dirtyWatches=new Set<string>();
 private lastMcapCheck=0;
 private signal?:WebSocket;private lock?:PoolClient;private refreshTimer?:ReturnType<typeof setInterval>;private flushTimer?:ReturnType<typeof setInterval>;
 private chain=Promise.resolve();private stopped=false;private feedHealthy=false;
 private readonly history=new HistoryClient();
 private readonly recovering=new Map<Context,symbol>();
 private readonly xxyy=process.env.XXYY_API_KEY?new XxyyTradeClient(process.env.XXYY_API_KEY):undefined;
 private readonly discovery:ProjectDiscovery;
 private readonly admissionCounts=new Map<string,{accepted:number;filtered:number;lastReceivedAt:number;reason?:string}>();
 private sourceRuns:Run[]=[];
 private mcapBusy=false;
 constructor(private readonly pool:Pool){this.discovery=new ProjectDiscovery(pool,signal=>this.receiveDiscovery(signal));}
 private enqueue(fn:()=>Promise<void>){this.chain=this.chain.then(fn).catch(e=>console.error('live service:',redact(e)));}
 async start(){
  const client=await this.pool.connect();
  const locked=(await client.query('SELECT pg_try_advisory_lock(63920924) AS acquired')).rows[0]?.acquired;
  if(!locked){client.release();console.log('live service standby: another owner holds advisory lock');return;}
  this.lock=client;
  this.projectRedis.on('error',()=>{});
  await this.projectRedis.connect().catch(()=>{});
  await this.refresh();this.connectSignals();
  this.refreshTimer=setInterval(()=>this.enqueue(()=>this.refresh()),5_000);
  this.flushTimer=setInterval(()=>{const receivedAt=Date.now();this.enqueue(()=>this.flushBars(receivedAt));},1_000);
  console.log('live service started; real orders',process.env.LIVE_TRADING_ENABLED==='true'?'armed by server configuration':'disabled');
 }
 async close(){this.stopped=true;this.history.close();if(this.refreshTimer)clearInterval(this.refreshTimer);if(this.flushTimer)clearInterval(this.flushTimer);for(const timer of this.signalRetries.values())clearTimeout(timer);this.signalRetries.clear();this.signal?.close();this.market.stop();this.projectRedis.disconnect();await this.discovery.close();await this.chain;await this.flushTelemetry();if(this.lock){await this.lock.query('SELECT pg_advisory_unlock(63920924)');this.lock.release();}}
 private async switchExecution(){
  const c=await this.pool.connect();try{await c.query('BEGIN');
   const switched=await c.query("UPDATE live_runs SET execution_version=$1,execution_switched_at=now(),strategy_json=jsonb_set(strategy_json,'{impulseCondition,selectionVersion}','\"pullback-v2\"'::jsonb) WHERE status='running' AND (execution_version<>$1 OR strategy_json#>>'{impulseCondition,selectionVersion}' IS DISTINCT FROM 'pullback-v2') RETURNING id,mode",[LIVE_EXECUTION_VERSION]);
   for(const r of switched.rows){
    if(r.mode==='paper')await c.query("UPDATE live_orders SET status='cancelled',raw_result=COALESCE(raw_result,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE run_id=$1 AND status='pending'",[r.id,JSON.stringify({cancelReason:'切换 Fib 选点规则，旧待成交模拟订单不追溯成交'})]);
    const holdings=(await c.query("SELECT chain,ca,pair_id,state_json->'position' AS position FROM live_watches WHERE run_id=$1 AND state_json->'position' IS NOT NULL AND state_json->'position'<>'null'::jsonb",[r.id])).rows;
    await c.query("INSERT INTO live_events(run_id,kind,event_key,event_time,payload) VALUES($1,'execution_switched',$2,$3,$4) ON CONFLICT(event_key) DO NOTHING",[r.id,`${r.id}:${LIVE_EXECUTION_VERSION}`,Date.now(),JSON.stringify({version:LIVE_EXECUTION_VERSION,impulseSelectionVersion:'pullback-v2',preservedPositions:holdings,reason:'收盘决策保持不变；未持仓逐根重建 Fib 候选，收盘突破作废；已有持仓沿用原入场锚点、成本及锁盈状态，历史预热不补发订单'})]);
   }
   // A crash between durable intent and network submission has an uncertain outcome.
   // Fail closed rather than ever resending it automatically.
   await c.query("UPDATE live_orders o SET status='unknown',updated_at=now() FROM live_runs r WHERE o.run_id=r.id AND r.mode='live' AND r.status='running' AND o.status='pending'");
   await c.query("UPDATE live_runs r SET execution_hold_reason=COALESCE(execution_hold_reason,'存在待核验实盘订单，禁止自动重发') WHERE mode='live' AND status='running' AND EXISTS(SELECT 1 FROM live_orders o WHERE o.run_id=r.id AND o.status IN ('submitted','unknown'))");
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 private async switchMarket(){
  const c=await this.pool.connect();try{await c.query('BEGIN');
   const switched=await c.query("UPDATE live_runs SET market_source='meme_market_v2',market_switched_at=now() WHERE status='running' AND market_source IS DISTINCT FROM 'meme_market_v2' RETURNING id,mode");
   for(const r of switched.rows){
    if(r.mode==='paper')await c.query("UPDATE live_orders SET status='cancelled',raw_result=COALESCE(raw_result,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE run_id=$1 AND status='pending'",[r.id,JSON.stringify({cancelReason:'切换 Meme Market 协议2，旧模拟待成交订单不追溯成交'})]);
    await c.query("INSERT INTO live_events(run_id,kind,event_key,event_time,payload) VALUES($1,'market_switched',$2,$3,$4) ON CONFLICT(event_key) DO NOTHING",[r.id,`${r.id}:meme-market-v2`,Date.now(),JSON.stringify({source:'meme_market_v2',delivery:'best_effort'})]);
   }
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 private async refresh(){
  if(this.stopped)return;
  await this.switchExecution();await this.switchMarket();
  const rows=(await this.pool.query("SELECT * FROM live_runs WHERE status='running'")).rows as Run[];
  this.sourceRuns=rows;this.discovery.update(rows);
  const active=new Set(rows.map(r=>r.id));
  const watchRows=(await this.pool.query("SELECT w.* FROM live_watches w JOIN live_runs r ON r.id=w.run_id WHERE r.status='running' AND w.status IN ('monitoring','recovering','pending_eviction')")).rows as Watch[];
  const runMap=new Map(rows.map(r=>[r.id,r]));
  for(const w of watchRows){const key=watchKey(w.run_id,w.chain,w.ca);const old=this.watches.get(key);if(old){const run=runMap.get(w.run_id)!;const changed=old.run.strategy_json.impulseCondition.selectionVersion!==run.strategy_json.impulseCondition.selectionVersion;old.run=run;old.watch={...w,last_trade_at:old.watch.last_trade_at??w.last_trade_at,current_mcap:old.watch.current_mcap??w.current_mcap};if(changed){old.evaluator=new LiveEvaluator(run.strategy_json,Number(w.signal_time),old.evaluator.snapshot());old.noOrdersBefore=Date.now();old.nextRecoveryAt=0;await this.markRecovering(old,'Fib 选点规则切换，保留持仓并重建候选');}continue;}
   const run=runMap.get(w.run_id);if(!run)continue;
   const ctx:Context={run,watch:w,evaluator:new LiveEvaluator(run.strategy_json,Number(w.signal_time),w.state_json?.history?w.state_json:undefined),ready:false,nextRecoveryAt:0,noOrdersBefore:Math.max(Date.now(),new Date(run.execution_switched_at??0).getTime())};
   this.watches.set(key,ctx);
   if(this.marketSessions.has(projectKey(w)))this.connected.add(pairKey(w.chain,w.pair_id));
   await this.markRecovering(ctx,'服务启动，等待行情订阅并补数');
  }
  for(const [key,ctx] of this.watches)if(!active.has(ctx.run.id)||!watchRows.some(w=>watchKey(w.run_id,w.chain,w.ca)===key))this.watches.delete(key);
  for(const ctx of this.watches.values()){
   const cap=effectiveExitCap(selectedProjectSources(ctx.run),ctx.watch.matched_sources??['memeinfo']);
   if(Number(ctx.watch.exit_market_cap??50000)!==cap){
    ctx.watch.exit_market_cap=String(cap);
    await this.pool.query('UPDATE live_watches SET exit_market_cap=$4 WHERE run_id=$1 AND chain=$2 AND ca=$3',[ctx.run.id,ctx.watch.chain,ctx.watch.ca,cap]);
    const last=this.latestCaps.get(projectKey(ctx.watch));
    if(last&&Date.now()-last.time<60000&&last.value<cap)await this.evictOrRetain(ctx,`配置更新，市值低于 ${cap} USD`);
    else this.lastMcapCheck=0;
   }
  }
  this.market.setProjects([...this.watches.values()].map(c=>({chain:c.watch.chain,ca:c.watch.ca})));
  for(const ctx of this.watches.values())this.prepareProject(ctx.watch);
  for(const ctx of this.watches.values())if(!ctx.ready&&!this.recovering.has(ctx)&&this.marketSessions.has(projectKey(ctx.watch))&&Date.now()>=ctx.nextRecoveryAt)await this.recover(ctx);
  if(Date.now()-this.lastMcapCheck>=60_000&&!this.mcapBusy){this.lastMcapCheck=Date.now();this.mcapBusy=true;void this.recheckMarketCaps().catch(e=>console.error('市值复查:',redact(e))).finally(()=>this.mcapBusy=false);}
  await this.reconcileOrders();
  for(const ctx of [...this.watches.values()])if(ctx.watch.exit_only&&!ctx.evaluator.state.position&&!await this.pending(ctx))await this.evictOrRetain(ctx,'低市值项目仓位及订单已结清');
  await this.flushTelemetry();
  await this.pool.query(`UPDATE live_runs r SET feed_state=CASE
   WHEN EXISTS(SELECT 1 FROM live_watches w WHERE w.run_id=r.id AND w.status='recovering') THEN 'recovering'
   WHEN EXISTS(SELECT 1 FROM live_watches w WHERE w.run_id=r.id AND w.status IN ('monitoring','pending_eviction')) THEN 'connected'
   ELSE 'connecting' END,
   feed_reason=CASE WHEN EXISTS(SELECT 1 FROM live_watches w WHERE w.run_id=r.id AND w.status='recovering') THEN feed_reason ELSE NULL END
   WHERE r.status='running'`);
  if(rows.length)await this.pool.query("UPDATE live_runs SET heartbeat_at=now() WHERE status='running'");
  for(const r of rows){const status:any={};for(const p of ['memeinfo','wallet','xxyy'] as const){if(!selectedProjectSources(r)[p].enabled)continue;status[p]={...(p==='memeinfo'?{state:this.feedHealthy?'connected':process.env.MEMEINFO_SIGNAL_TOKEN?'connecting':'unconfigured'}:this.discovery.status[p]),admission:this.admissionCounts.get(`${r.id}:${p}`)??{accepted:0,filtered:0},scope:'当前服务会话'};}await this.pool.query('UPDATE live_runs SET source_status=$2 WHERE id=$1',[r.id,JSON.stringify(status)]);}
  for(const r of rows){const contexts=[...this.watches.values()].filter(c=>c.run.id===r.id),subscribed=contexts.filter(c=>this.marketSessions.has(projectKey(c.watch))).length;await this.pool.query('UPDATE live_runs SET market_status=$2 WHERE id=$1',[r.id,JSON.stringify({expectedProtocol:2,protocol:subscribed?2:null,delivery:'best_effort',lastMessageAt:this.market.lastMessageAt,subscribed,ready:contexts.filter(c=>c.ready).length,cache:this.projects.storageStatus,supplyReady:contexts.filter(c=>this.projects.peek(c.watch)).length,quality:this.quality,qualityScope:'当前 Worker 会话全部任务'})]);}
 }
 private connectSignals(){
  if(this.stopped||!process.env.MEMEINFO_SIGNAL_TOKEN)return;
  const ws=new WebSocket(process.env.MEMEINFO_SIGNAL_URL??'wss://app.memeinfo.net/api/ws/external/signal-events',{headers:{Authorization:`Bearer ${process.env.MEMEINFO_SIGNAL_TOKEN}`}});
  this.signal=ws;
  ws.on('open',()=>{this.feedHealthy=true;});
  ws.on('message',raw=>{const s=parseProjectSignal(raw.toString());if(!s)return;const signal:Discovery={...s,provider:'memeinfo',observedAt:Date.now()};if(this.sourceRuns.some(r=>r.chain===s.chain&&acceptsDiscovery(r,signal)))void this.discovery.accept(signal).catch(e=>console.error('信号持久化失败:',redact(e)));});
  ws.on('close',()=>{this.feedHealthy=false;if(!this.stopped)setTimeout(()=>this.connectSignals(),3_000);});
  ws.on('error',error=>console.error('MemeInfo signal connection:',redact(error)));
 }
 private async receiveDiscovery(signal:Discovery){
  if(this.stopped)return;
  const runs=this.sourceRuns.filter(r=>r.chain===signal.chain&&acceptsDiscovery(r,signal));if(!runs.length)return;
  if(signal.provider==='xxyy'&&!runs.some(r=>qualifiesSource('xxyy',selectedProjectSources(r).xxyy,signal.facts??{},Date.now()))){for(const r of runs)this.countAdmission(r.id,signal,false,'XXYY 本地复核未通过');return;}
  const capacity=(await this.pool.query(`SELECT r.id,COUNT(w.*) FILTER(WHERE w.status IN ('monitoring','recovering','pending_eviction'))::int AS active,
   BOOL_OR(w.ca=$2 AND w.status IN ('monitoring','recovering','pending_eviction')) AS existing
   FROM live_runs r LEFT JOIN live_watches w ON w.run_id=r.id WHERE r.id=ANY($1::uuid[]) GROUP BY r.id`,[runs.map(r=>r.id),signal.ca])).rows;
  if(!capacity.some(r=>canMonitor(Number(r.active),!!r.existing))){for(const r of runs)this.countAdmission(r.id,signal,false,'监控名额已满');return;}
  // Lookup must not block the serialized market/decision queue.
  const info=await this.projects.fresh(signal);
  const latest=this.latestCaps.get(projectKey(signal));
  const facts={createdAt:info.createdAt,marketCap:info.marketCap,...signal.facts};
  if(latest?.pairId===info.pairId&&Date.now()-latest.time<60000)facts.marketCap=latest.value;
  signal={...signal,facts};
  await new Promise<void>((resolve,reject)=>this.enqueue(async()=>{try{if(!this.stopped)await this.onSignal(signal,info);resolve();}catch(e){reject(e);}}));
 }
 private countAdmission(id:string,signal:Discovery,accepted:boolean,reason?:string){const key=`${id}:${signal.provider}`,c=this.admissionCounts.get(key)??{accepted:0,filtered:0,lastReceivedAt:0};c[accepted?'accepted':'filtered']++;c.lastReceivedAt=Date.now();c.reason=reason;this.admissionCounts.set(key,c);}
 private async onSignal(signal:Discovery,pool:{pairId:string;dexId:string}){
  if(signal.time>Date.now()+5_000)return;
  const runs=(await this.pool.query("SELECT * FROM live_runs WHERE status='running' AND chain=$1 AND started_at IS NOT NULL",[signal.chain])).rows;
  const relevant=runs.filter(r=>acceptsDiscovery(r,signal));
  if(!relevant.length)return;
  const capacities=(await this.pool.query(`SELECT r.id,COUNT(w.*) FILTER(WHERE w.status IN ('monitoring','recovering','pending_eviction'))::int AS active,
   BOOL_OR(w.ca=$2 AND w.status IN ('monitoring','recovering','pending_eviction')) AS existing
   FROM live_runs r LEFT JOIN live_watches w ON w.run_id=r.id WHERE r.id=ANY($1::uuid[]) GROUP BY r.id`,[relevant.map(r=>r.id),signal.ca])).rows;
  if(!capacities.some(r=>canMonitor(Number(r.active),!!r.existing))){
   await this.pool.query("INSERT INTO live_events(chain,ca,kind,event_time,payload) VALUES($1,$2,'signal_skipped',$3,$4)",[signal.chain,signal.ca,signal.time,JSON.stringify({reason:'all_matching_runs_full',limit:LIVE_CA_LIMIT})]);return;
  }
  const marketCap=signal.facts?.marketCap;
  const {pairId,dexId}=pool;
  const c=await this.pool.connect();
  try{await c.query('BEGIN');
   // Serialize admissions per run; concurrent signals cannot each claim the last slot.
   let admitted=(await c.query("SELECT * FROM live_runs WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",[relevant.map(r=>r.id)])).rows.filter(r=>r.status==='running'&&acceptsDiscovery(r,signal)&&qualifiesSource(signal.provider,selectedProjectSources(r)[signal.provider],signal.facts??{},Date.now()));
   for(const r of relevant)if(!admitted.some(a=>a.id===r.id))this.countAdmission(r.id,signal,false,'市值、年龄、KOL 或来源条件不符合');
   if(signal.provider==='xxyy'){
    const seen=(await c.query("SELECT run_id FROM live_watches WHERE run_id=ANY($1::uuid[]) AND chain=$2 AND ca=$3 AND status<>'evicted_low_mcap' AND 'xxyy'=ANY(matched_sources)",[admitted.map(r=>r.id),signal.chain,signal.ca])).rows;
    admitted=admitted.filter(r=>!seen.some(w=>w.run_id===r.id));
   }
   if(!admitted.length){await c.query('COMMIT');return;}
   await c.query(`INSERT INTO token_signal_events(chain,ca,signal_source,detail_id,signal_time,source_signal,provenance)
    VALUES($1,$2,$3,$4,$5,$6,'[]') ON CONFLICT(chain,ca,signal_source,detail_id) DO NOTHING`,[signal.chain,signal.ca,signal.source,signal.key,signal.time,JSON.stringify(signal.identity)]);
   await c.query(`INSERT INTO token_info(chain,ca,pair,signal_source,source_signal,signal_time) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(chain,ca,pair) DO UPDATE SET signal_source=CASE WHEN token_info.signal_time IS NULL OR EXCLUDED.signal_time<token_info.signal_time THEN EXCLUDED.signal_source ELSE token_info.signal_source END,
    source_signal=CASE WHEN token_info.signal_time IS NULL OR EXCLUDED.signal_time<token_info.signal_time THEN EXCLUDED.source_signal ELSE token_info.source_signal END,
    signal_time=LEAST(COALESCE(token_info.signal_time,EXCLUDED.signal_time),EXCLUDED.signal_time)`,[signal.chain,signal.ca,pairId,signal.source,JSON.stringify(signal.identity),signal.time]);
   for(const r of admitted){
    const active=Number((await c.query("SELECT COUNT(*) AS count FROM live_watches WHERE run_id=$1 AND status IN ('monitoring','recovering','pending_eviction')",[r.id])).rows[0].count);
    const prior=(await c.query('SELECT status,signal_key,matched_sources FROM live_watches WHERE run_id=$1 AND chain=$2 AND ca=$3',[r.id,signal.chain,signal.ca])).rows[0];
    const matched:ProjectProvider[]=prior&&prior.status!=='evicted_low_mcap'?[...new Set<ProjectProvider>([...(prior.matched_sources??['memeinfo']),signal.provider])]:[signal.provider];
    const exitCap=effectiveExitCap(selectedProjectSources(r),matched);
    if(prior?.status!=='evicted_low_mcap'&&prior){
     await c.query('UPDATE live_watches SET matched_sources=$4,exit_market_cap=$5 WHERE run_id=$1 AND chain=$2 AND ca=$3',[r.id,signal.chain,signal.ca,matched,exitCap]);
     if(signal.provider==='xxyy'&&prior.matched_sources?.includes('xxyy'))continue;
     await c.query('UPDATE live_runs SET last_signal_at=GREATEST(COALESCE(last_signal_at,0),$2) WHERE id=$1',[r.id,signal.time]);
     await c.query("INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_key,event_time,payload) VALUES($1,$2,$3,$4,'external_signal',$5,$6,$7) ON CONFLICT(event_key) DO NOTHING",[r.id,signal.chain,signal.ca,pairId,`${r.id}:${signal.key}`,signal.time,JSON.stringify(signal.identity)]);
     continue;
    }
    if(!canMonitor(active,false)){await c.query("INSERT INTO live_events(run_id,chain,ca,kind,event_time,payload) VALUES($1,$2,$3,'signal_skipped',$4,$5)",[r.id,signal.chain,signal.ca,signal.time,JSON.stringify({reason:'run_full',limit:LIVE_CA_LIMIT})]);continue;}
    if(prior?.signal_key===signal.key)continue;
    const admittedAt=Date.now(),entryTime=signal.provider==='memeinfo'?signal.time:Math.max(signal.time,admittedAt);
    await c.query(`INSERT INTO live_watches(run_id,chain,ca,pair_id,dex_id,signal_source,signal_key,signal_time,status,state_json,last_candle_time,current_mcap,mcap_checked_at,recovery_reason,matched_sources,exit_market_cap,admitted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'recovering','{}',NULL,$9,now(),'新信号入组，预热指标',$10,$11,$12)
      ON CONFLICT(run_id,chain,ca) DO UPDATE SET pair_id=EXCLUDED.pair_id,dex_id=EXCLUDED.dex_id,signal_source=EXCLUDED.signal_source,signal_key=EXCLUDED.signal_key,signal_time=EXCLUDED.signal_time,status='recovering',state_json='{}',last_candle_time=NULL,current_mcap=EXCLUDED.current_mcap,mcap_checked_at=now(),recovery_reason=EXCLUDED.recovery_reason,matched_sources=EXCLUDED.matched_sources,exit_market_cap=EXCLUDED.exit_market_cap,admitted_at=EXCLUDED.admitted_at,exit_only=false`,[r.id,signal.chain,signal.ca,pairId,dexId,signal.source,signal.key,entryTime,marketCap,matched,exitCap,admittedAt]);
    this.countAdmission(r.id,signal,true);
    await c.query("UPDATE live_runs SET last_signal_at=GREATEST(COALESCE(last_signal_at,0),$2),feed_state='connecting' WHERE id=$1",[r.id,signal.time]);
    await c.query("INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_key,event_time,payload) VALUES($1,$2,$3,$4,'external_signal',$5,$6,$7) ON CONFLICT(event_key) DO NOTHING",[r.id,signal.chain,signal.ca,pairId,`${r.id}:${signal.key}`,signal.time,JSON.stringify(signal.identity)]);
   }
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  await this.refresh();
 }
 private async onTrade(trade:MarketTrade){
  if(this.stopped || !Number.isSafeInteger(trade.time) || trade.time<0 || trade.time>Date.now()+5_000)return;
  // The connection starts mid-bucket: never persist that incomplete bar as a full input.
  const epoch=this.marketEpochs.get(projectKey(trade));
  if(epoch!==undefined&&trade.time<Math.ceil(epoch/60_000)*60_000)return;
  if(trade.time<(this.marketInputAfter.get(projectKey(trade))??0))return;
  const contexts=[...this.watches.values()].filter(c=>c.watch.chain===trade.chain&&c.watch.ca===trade.ca&&c.watch.pair_id===trade.pairId&&c.run.status==='running');
  if(!contexts.length)return;
  await this.flushBars(Math.min(Date.now(),trade.time));
  const result=this.aggregator.acceptDetailed(trade);
  if(result.late)for(const ctx of contexts)this.bump(ctx.run.id,'late');
  if(!result.accepted){if(result.reason==='closed'||result.reason==='too_old')for(const ctx of contexts)this.bump(ctx.run.id,result.reason==='closed'?'closed':'tooOld');return;}
  if(this.connected.has(pairKey(trade.chain,trade.pairId)))this.confirmedFeeds.add(pairKey(trade.chain,trade.pairId));
  if(result.late)return; // May update an open candle, but never simulate a fill or a tick exit.
  if(trade.mcap!==undefined)this.latestCaps.set(projectKey(trade),{value:trade.mcap,time:trade.time,pairId:trade.pairId});
  for(const ctx of contexts){
   if(trade.time<=Number(ctx.watch.last_trade_at??0))continue;
   ctx.watch.last_trade_at=String(trade.time);if(trade.mcap!==undefined)ctx.watch.current_mcap=String(trade.mcap);
   this.dirtyWatches.add(watchKey(ctx.run.id,ctx.watch.chain,ctx.watch.ca));
   this.bump(ctx.run.id,'lastTradeAt',trade.time);
   if(trade.mcap!==undefined&&trade.mcap<Number(ctx.watch.exit_market_cap??MIN_MARKET_CAP))await this.evictOrRetain(ctx,`实时市值低于 ${ctx.watch.exit_market_cap??MIN_MARKET_CAP} USD`);
   if(ctx.watch.status==='evicted_low_mcap')continue;
   if(!ctx.ready)continue;
   if(ctx.run.value_type==='mcap'&&(!trade.mcap||trade.mcap<=0)){await this.markRecovering(ctx,'实时成交缺少可靠市值');continue;}
   ctx.evaluator.state.lastTokenPrice=trade.price;
  }
 }
 private async saveBar(bar:ClosedMarketBar){
  const c=bar.candle;
  await this.pool.query(`INSERT INTO meme_kline(chain,ca,pair_id,interval,open_time,close_time,open,high,low,close,volume,trade_count,type,source,raw_data,valid)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'meme_market_v2',$14,true)
    ON CONFLICT(chain,pair_id,interval,open_time,type) DO NOTHING RETURNING open_time`,
    [bar.symbol.chain,bar.symbol.ca,bar.symbol.pairId,bar.interval,c.time,c.closeTime,c.open,c.high,c.low,c.close,c.volume,bar.tradeCount,bar.type,JSON.stringify({feed:'meme_market_v2',protocol:2,delivery:'best_effort',session:this.marketSessions.get(projectKey(bar.symbol)),closed:true,synthetic:!!c.synthetic,syntheticReason:c.synthetic?'assumed_no_trade':undefined,closeTradeId:bar.closeTradeId,closeTradeTime:bar.closeTradeTime,marketCapBasis:bar.marketCapBasis,derivedSupply:bar.derivedSupply,hasDerivedMarketCap:bar.hasDerivedMarketCap})]);
 }
 private async flushBars(now:number){
  this.aggregator.flush(now,(bar,time)=>this.connected.has(pairKey(bar.symbol.chain,bar.symbol.pairId))&&this.confirmedFeeds.has(pairKey(bar.symbol.chain,bar.symbol.pairId))&&[...this.watches.values()].some(ctx=>ctx.watch.chain===bar.symbol.chain&&ctx.watch.pair_id===bar.symbol.pairId&&time>=ctx.noOrdersBefore));
  while(this.closedBars.length){
   const end=Math.min(...this.closedBars.map(b=>b.candle.closeTime));
   if(end>now)break;
   const bars=this.closedBars.filter(b=>b.candle.closeTime===end);
   for(const bar of bars)await this.saveBar(bar);
   await this.executeBars(bars);
   this.closedBars=this.closedBars.filter(b=>b.candle.closeTime!==end);
  }
 }
 private async executeBars(bars:ClosedMarketBar[]){
  const work:Array<{ctx:Context;bar:ClosedMarketBar;price:ClosedMarketBar}>=[];
  for(const ctx of this.watches.values()){
   if(!ctx.ready || ctx.run.status!=='running' || !this.connected.has(pairKey(ctx.watch.chain,ctx.watch.pair_id)))continue;
   const matches=(b:ClosedMarketBar)=>b.symbol.chain===ctx.watch.chain&&b.symbol.ca===ctx.watch.ca&&b.symbol.pairId===ctx.watch.pair_id&&b.interval===ctx.run.interval;
   const bar=bars.find(b=>matches(b)&&b.type===ctx.run.value_type),price=bars.find(b=>matches(b)&&b.type==='price');
   if(!bar){if(price&&ctx.run.value_type==='mcap')await this.markRecovering(ctx,'收盘缺少配对市值K线，禁止成交');continue;}
   if(bar.candle.time<ctx.noOrdersBefore || bar.candle.time<=(ctx.evaluator.state.lastCandleTime??-1))continue;
   if(simulatedBarPrice(ctx.run.value_type,bar.candle.close,bar,price)===undefined){await this.markRecovering(ctx,'收盘价格／市值无法可靠配对，禁止成交');continue;}
   work.push({ctx,bar,price:price!});
  }
  work.sort((a,b)=>{const x=`${a.ctx.run.id}:${a.ctx.watch.chain}:${a.ctx.watch.ca}:${a.ctx.watch.pair_id}`,y=`${b.ctx.run.id}:${b.ctx.watch.chain}:${b.ctx.watch.ca}:${b.ctx.watch.pair_id}`;return x<y?-1:x>y?1:0;});
  if(!work.length)return;
  const backups=work.map(({ctx})=>({ctx,state:ctx.evaluator.snapshot(),run:{...ctx.run},watch:{...ctx.watch}}));
  const client=await this.pool.connect();this.executionClient=client;this.submissions=[];
  try{await client.query('BEGIN');
   const ids=[...new Set(work.map(x=>x.ctx.run.id))];
   for(const id of ids){const row=(await client.query('SELECT * FROM live_runs WHERE id=$1 FOR UPDATE',[id])).rows[0];for(const {ctx} of work)if(ctx.run.id===id)Object.assign(ctx.run,row);}
   const decisions=[];
   for(const item of work){const {ctx,bar,price}=item;if(ctx.run.status!=='running'||!this.connected.has(pairKey(ctx.watch.chain,ctx.watch.pair_id)))continue;
    const saved=(await client.query('SELECT state_json,last_candle_time FROM live_watches WHERE run_id=$1 AND chain=$2 AND ca=$3 FOR UPDATE',[ctx.run.id,ctx.watch.chain,ctx.watch.ca])).rows[0];
    if(!saved)continue;
    if(saved.state_json?.history)ctx.evaluator=new LiveEvaluator(ctx.run.strategy_json,Number(ctx.watch.signal_time),saved.state_json);
    if(saved.last_candle_time!==null && Number(saved.last_candle_time)>=bar.candle.time)continue;
    ctx.evaluator.state.lastTokenPrice=price.candle.close;
    const decision=ctx.evaluator.onClosedCandle(bar.candle);
    decisions.push({...item,decision});
   }
   // Same timestamp: exits release cash/capacity before deterministic entries.
   for(const side of ['sell','buy'] as const)for(const {ctx,bar,price,decision} of decisions){
    if(!ctx.ready||!this.connected.has(pairKey(ctx.watch.chain,ctx.watch.pair_id)))throw new Error('行情在决策事务期间中断，回滚本轮');
    if(!decision||decision.side!==side||await this.pending(ctx))continue;
    await this.createDecision(ctx,decision,bar,price);
   }
   for(const {ctx,bar} of decisions){ctx.evaluator.confirmClose(bar.candle);
    ctx.watch.last_candle_time=String(bar.candle.time);
    await client.query('UPDATE live_watches SET state_json=$2,last_candle_time=$3 WHERE run_id=$1 AND chain=$4 AND ca=$5',[ctx.run.id,JSON.stringify(ctx.evaluator.snapshot()),bar.candle.time,ctx.watch.chain,ctx.watch.ca]);
   }
   for(const id of ids){const run=work.find(w=>w.ctx.run.id===id)!.ctx.run;if(run.mode==='paper')await this.recordEquity(run,bars[0]!.candle.closeTime);}
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');for(const b of backups){b.ctx.evaluator=new LiveEvaluator(b.ctx.run.strategy_json,Number(b.ctx.watch.signal_time),b.state);Object.assign(b.ctx.run,b.run);Object.assign(b.ctx.watch,b.watch);}this.submissions=[];throw e;
  }finally{this.executionClient=undefined;client.release();}
  const submissions=this.submissions;this.submissions=[];
  for(const s of submissions)await this.submitLive(s.ctx,s.id,s.decision,s.amount);
  for(const {ctx} of work)if(ctx.run.mode==='paper'&&!ctx.evaluator.state.position&&(ctx.watch.exit_only||ctx.watch.status==='pending_eviction'))await this.evictOrRetain(ctx,'低市值持仓已平仓');
 }
 private async recordEquity(run:Run,time:number){
  const watches=[...this.watches.values()].filter(c=>c.run.id===run.id),cash=Number(run.cash);
  const held=watches.reduce((sum,ctx)=>sum+(ctx.evaluator.state.position?.quantity??0)*(ctx.evaluator.state.lastTokenPrice??0),0);
  const basis=watches.reduce((sum,ctx)=>sum+(ctx.evaluator.state.position?.costBasisUsd??0),0);
  await this.db.query(`INSERT INTO live_equity_curve(run_id,time,equity,cash,unrealized) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(run_id,time) DO UPDATE SET equity=EXCLUDED.equity,cash=EXCLUDED.cash,unrealized=EXCLUDED.unrealized`,[run.id,time,cash+held,cash,held-basis]);
 }
 /** Await only queued state application, never put an HTTP await on the event chain. */
 private queuedRecovery<T>(valid:()=>boolean,fn:()=>Promise<T>):Promise<T|undefined>{
  return new Promise((resolve,reject)=>this.enqueue(async()=>{try{resolve(valid()?await fn():undefined);}catch(e){reject(e);}}));
 }
 private launchRecovery(ctx:Context){
  const token=Symbol(),pair=ctx.watch.pair_id,epoch=this.marketEpochs.get(projectKey(ctx.watch)),session=this.marketSessions.get(projectKey(ctx.watch)),boundary=ctx.noOrdersBefore;
  this.recovering.set(ctx,token);
  const valid=()=>!this.stopped&&this.recovering.get(ctx)===token&&this.watches.get(watchKey(ctx.run.id,ctx.watch.chain,ctx.watch.ca))===ctx&&ctx.run.status==='running'&&ctx.watch.pair_id===pair&&ctx.noOrdersBefore===boundary&&this.marketEpochs.get(projectKey(ctx.watch))===epoch&&this.marketSessions.get(projectKey(ctx.watch))===session&&!this.supplyBlocked.has(projectKey(ctx.watch));
  const step=ctx.run.interval==='30s'?30_000:60_000,to=Math.floor(Date.now()/step)*step;
  const from=ctx.watch.last_candle_time?Number(ctx.watch.last_candle_time)+step:to-600*step;
  void (async()=>{
   let issue='历史接口未返回当前范围的已收盘 K 线',count=0,discarded=0;
   try{
    for(const window of backfillWindows(from,to,step)){
     if(!valid())return;
     const types=ctx.run.value_type==='mcap'?['price','mcap'] as const:['price'] as const;
     const results=await Promise.all(types.map(type=>this.history.get({chain:ctx.watch.chain,pair,interval:ctx.run.interval,type,from:window.from,to:window.to})));
     if(!valid())return;
     discarded+=results.reduce((sum,result)=>sum+(result.quality?.discarded??0),0);
     const target=results[types.findIndex(type=>type===ctx.run.value_type)]!;count+=target.rows.length;
     await this.queuedRecovery(valid,()=>this.applyHistory(ctx,types.map((type,i)=>({type,result:results[i]})),valid));
    }
    const required=localWarmupBars(ctx.run.strategy_json);
    issue=count===0?'历史接口返回空数据':ctx.evaluator.state.history.length<required?`历史指标预热不足 ${ctx.evaluator.state.history.length}/${required} 根`:'历史尾部未覆盖最近收盘桶';
   }catch(error){issue=redact(error);}
   if(discarded)issue=`已丢弃 ${discarded} 条非法历史 K 线（各维度合计）；${issue}`;
   await this.queuedRecovery(valid,()=>this.finishRecovery(ctx,issue,valid));
  })().catch(error=>console.error('history recovery:',redact(error))).finally(()=>{if(this.recovering.get(ctx)===token)this.recovering.delete(ctx);});
 }
 private async applyHistory(ctx:Context,series:Array<{type:'price'|'mcap';result:HistoryResult}>,valid:()=>boolean){
  const c=await this.pool.connect(),step=ctx.run.interval==='30s'?30_000:60_000;
  try{
   await c.query('BEGIN');
   const run=(await c.query('SELECT status FROM live_runs WHERE id=$1 FOR UPDATE',[ctx.run.id])).rows[0];
   if(!valid()||run?.status!=='running'){await c.query('ROLLBACK');return;}
   for(const {type,result} of series)if(result.quality?.discarded){
    const key=createHash('sha256').update(JSON.stringify([ctx.run.id,ctx.watch.chain,ctx.watch.pair_id,ctx.run.interval,type,result.quality])).digest('hex');
    await c.query(`INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_key,event_time,payload)
     VALUES($1,$2,$3,$4,'history_candles_discarded',$5,$6,$7) ON CONFLICT(event_key) DO NOTHING`,
     [ctx.run.id,ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,`history-discard:${key}`,Date.now(),JSON.stringify({type,interval:ctx.run.interval,retained:result.rows.length,...result.quality,endpoint:result.endpoint,traceId:result.traceId})]);
   }
   for(const {type,result} of series)for(let i=0;i<result.rows.length;i+=500){
    if(!valid()){await c.query('ROLLBACK');return;}
    await c.query(`INSERT INTO meme_kline(chain,ca,pair_id,interval,open_time,close_time,open,high,low,close,volume,trade_count,type,source,raw_data,valid)
     SELECT $1,$2,$3,$4,x.time,x.time+$5,x.open,x.high,x.low,x.close,x.volume,0,$6,'memeinfo_xxyy',$8::jsonb,true
     FROM jsonb_to_recordset($7::jsonb) AS x(time bigint,open numeric,high numeric,low numeric,close numeric,volume numeric)
     ON CONFLICT(chain,pair_id,interval,open_time,type) DO NOTHING`,[ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,ctx.run.interval,step,type,JSON.stringify(result.rows.slice(i,i+500)),JSON.stringify({upstream:'xxyy',endpoint:result.endpoint,traceId:result.traceId,quality:result.quality})]);
   }
   const target=series.find(s=>s.type===ctx.run.value_type)!.result.rows;
   const evaluator=new LiveEvaluator(ctx.run.strategy_json,Number(ctx.watch.signal_time),ctx.evaluator.snapshot());
   // Read back authoritative stored values on conflict, rather than evaluating a different HTTP snapshot.
   const stored=target.length?(await c.query(`SELECT open_time AS time,open,high,low,close,volume FROM meme_kline WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND valid IS DISTINCT FROM false AND open_time=ANY($6::bigint[]) ORDER BY open_time`,[ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,ctx.run.interval,ctx.run.value_type,target.map(r=>r.time)])).rows:[];
   for(const row of stored){
    const time=Number(row.time),prior=evaluator.state.history.at(-1);
    if(prior)for(let t=prior.time+step;t<time;t+=step)evaluator.onClosedCandle({time:t,closeTime:t+step,open:prior.close,high:prior.close,low:prior.close,close:prior.close,volume:0,synthetic:true,valid:true},true);
    evaluator.onClosedCandle({time,closeTime:time+step,open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume),valid:true},true);
   }
   if(!valid()){await c.query('ROLLBACK');return;}
   const last=evaluator.state.lastCandleTime;
   if(last!==undefined)await c.query('UPDATE live_watches SET state_json=$2,last_candle_time=$3 WHERE run_id=$1 AND chain=$4 AND ca=$5',[ctx.run.id,JSON.stringify(evaluator.snapshot()),last,ctx.watch.chain,ctx.watch.ca]);
   if(!valid()){await c.query('ROLLBACK');return;}
   await c.query('COMMIT');
   if(valid()){ctx.evaluator=evaluator;if(last!==undefined)ctx.watch.last_candle_time=String(last);}
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 /** Extend a historical snapshot only with an unbroken, already-closed live tail from this epoch. */
 private async appendConnectedHistory(ctx:Context,valid:()=>boolean){
  const step=ctx.run.interval==='30s'?30_000:60_000,last=ctx.evaluator.state.lastCandleTime;
  if(last===undefined||last+step<Math.ceil(ctx.noOrdersBefore/step)*step)return;
  const rows=(await this.pool.query(`SELECT open_time AS time,close_time AS "closeTime",open,high,low,close,volume FROM meme_kline
   WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND source='meme_market_v2' AND valid IS DISTINCT FROM false AND open_time>$6 AND close_time<=$7 ORDER BY open_time LIMIT 5000`,[ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,ctx.run.interval,ctx.run.value_type,last,Math.floor(Date.now()/step)*step])).rows;
  if(!valid()||!rows.length)return;
  const evaluator=new LiveEvaluator(ctx.run.strategy_json,Number(ctx.watch.signal_time),ctx.evaluator.snapshot());
  let expected=last+step;
  for(const row of rows){if(Number(row.time)!==expected)break;evaluator.onClosedCandle({time:Number(row.time),closeTime:Number(row.closeTime),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume)},true);expected+=step;}
  if(expected===last+step||!valid())return;
  await this.pool.query('UPDATE live_watches SET state_json=$2,last_candle_time=$3 WHERE run_id=$1 AND chain=$4 AND ca=$5',[ctx.run.id,JSON.stringify(evaluator.snapshot()),expected-step,ctx.watch.chain,ctx.watch.ca]);
  if(valid()){ctx.evaluator=evaluator;ctx.watch.last_candle_time=String(expected-step);}
 }
 /** No historical orders or risk-state resets when the history provider is unavailable. */
 private async warmupFromConnectedFeed(ctx:Context,valid=()=>true):Promise<{ready:boolean;count:number;required:number}>{
  const required=localWarmupBars(ctx.run.strategy_json);
  if(ctx.evaluator.state.position)return {ready:false,count:0,required};
  const step=ctx.run.interval==='30s'?30_000:60_000;
  const first=Math.ceil(ctx.noOrdersBefore/step)*step;
  const to=Math.floor(Date.now()/step)*step;
  if(first>=to)return {ready:false,count:0,required};
  const rows=(await this.pool.query(`SELECT open_time AS time,close_time AS "closeTime",open,high,low,close,volume
   FROM (SELECT open_time,close_time,open,high,low,close,volume FROM meme_kline
    WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5
      AND source='meme_market_v2' AND valid IS DISTINCT FROM false AND open_time>=$6 AND close_time<=$7
    ORDER BY open_time DESC LIMIT $8) recent ORDER BY open_time`,
   [ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,ctx.run.interval,ctx.run.value_type,first,to,Math.min(5000,Math.max(required,512))])).rows;
  if(!valid()||rows.length<required||Number(rows.at(-1)?.time)<to-step)return {ready:false,count:rows.length,required};
  const previous=ctx.evaluator.snapshot();
  const evaluator=new LiveEvaluator(ctx.run.strategy_json,Number(ctx.watch.signal_time),{
   history:[],lastEntryMatch:false,lastAddMatch:false,trades:previous.trades,lastTokenPrice:previous.lastTokenPrice,
  });
  for(const row of rows){
   const prior=evaluator.state.history.at(-1);
   if(prior&&Number(row.time)!==prior.time+step)return {ready:false,count:0,required};
   evaluator.onClosedCandle({time:Number(row.time),closeTime:Number(row.closeTime),open:Number(row.open),high:Number(row.high),low:Number(row.low),close:Number(row.close),volume:Number(row.volume)},true);
  }
  if(!valid())return {ready:false,count:rows.length,required};
  await this.pool.query('UPDATE live_watches SET state_json=$2,last_candle_time=$3 WHERE run_id=$1 AND chain=$4 AND ca=$5',
   [ctx.run.id,JSON.stringify(evaluator.snapshot()),rows.at(-1)!.time,ctx.watch.chain,ctx.watch.ca]);
  if(!valid())return {ready:false,count:rows.length,required};
  ctx.evaluator=evaluator;
  ctx.watch.last_candle_time=String(rows.at(-1)!.time);
  return {ready:true,count:rows.length,required};
 }
 private async markRecovering(ctx:Context,reason:string,retryMs=5_000){
  ctx.ready=false;ctx.watch.status='recovering';ctx.nextRecoveryAt=Date.now()+retryMs;
  await this.pool.query("UPDATE live_watches SET status='recovering',recovery_reason=$4 WHERE run_id=$1 AND chain=$2 AND ca=$3",[ctx.run.id,ctx.watch.chain,ctx.watch.ca,reason]);
  await this.pool.query("UPDATE live_runs SET feed_state='recovering',feed_reason=$2 WHERE id=$1 AND status='running'",[ctx.run.id,reason]);
 }
 private async recover(ctx:Context){
  ctx.nextRecoveryAt=Date.now()+10_000;
  try{
   const pool=this.projects.peek(ctx.watch);
   if(!pool){this.prepareProject(ctx.watch);await this.markRecovering(ctx,`等待项目供应量资料：${this.projects.status(ctx.watch)?.error??'正在查询'}`);return;}
   if(!pool)throw new Error('主池查询缺少可订阅交易池');
   if(pool.pairId!==ctx.watch.pair_id){
    if(ctx.evaluator.state.position&&pool.pairId!==ctx.watch.pair_id)throw new Error('已有持仓主池发生变化，暂停策略等待核验；不迁移旧持仓行情');
    this.aggregator.discardPair(ctx.watch.chain,ctx.watch.pair_id);
    const state=ctx.evaluator.snapshot();if(!state.position){state.history=[];state.lastCandleTime=undefined;state.pendingImpulse=undefined;state.lastEntryMatch=false;state.lastAddMatch=false;state.candidateHadPosition=false;ctx.watch.last_candle_time=null;}
    ctx.watch.pair_id=pool.pairId;ctx.watch.dex_id=pool.dexId;ctx.evaluator=new LiveEvaluator(ctx.run.strategy_json,Number(ctx.watch.signal_time),state);
    await this.pool.query('UPDATE live_watches SET pair_id=$4,dex_id=$5,last_candle_time=$6,state_json=$7 WHERE run_id=$1 AND chain=$2 AND ca=$3',[ctx.run.id,ctx.watch.chain,ctx.watch.ca,pool.pairId,pool.dexId,ctx.watch.last_candle_time,JSON.stringify(state)]);
    ctx.noOrdersBefore=Date.now();this.connected.add(pairKey(ctx.watch.chain,ctx.watch.pair_id));
    throw new Error('主池已切换，等待新交易池订阅确认');
   }
   if(pool.dexId!==ctx.watch.dex_id){ctx.watch.dex_id=pool.dexId;await this.pool.query('UPDATE live_watches SET dex_id=$4 WHERE run_id=$1 AND chain=$2 AND ca=$3',[ctx.run.id,ctx.watch.chain,ctx.watch.ca,pool.dexId]);}
   this.launchRecovery(ctx);
  }catch(e){await this.markRecovering(ctx,`补行情失败，稍后重试：${redact(e)}`,60_000);}
 }
 private async finishRecovery(ctx:Context,issue:string,valid:()=>boolean){
  try{
   await this.appendConnectedHistory(ctx,valid);
   if(!valid())return;
   const step=ctx.run.interval==='30s'?30_000:60_000;
   if(ctx.evaluator.state.history.length<localWarmupBars(ctx.run.strategy_json)||(ctx.evaluator.state.lastCandleTime??0)<Math.floor(Date.now()/step)*step-step){
    const warmup=await this.warmupFromConnectedFeed(ctx,valid);
    if(!valid())return;
    if(!warmup.ready){
     await this.markRecovering(ctx,`${issue}；实时行情预热 ${warmup.count}/${warmup.required} 根，期间暂停策略交易${ctx.evaluator.state.position?'；已有持仓止损无法保证及时执行':''}`,60_000);
     return;
    }
   }
   if(!valid())return;
   const current=(await this.pool.query('SELECT status FROM live_runs WHERE id=$1',[ctx.run.id])).rows[0];
   if(!valid()||current?.status!=='running')return;
   this.connected.add(pairKey(ctx.watch.chain,ctx.watch.pair_id));
   if(!ctx.evaluator.state.history.length)throw new Error('尚无可用历史行情，等待重试');
   const boundary=Date.now();
   if(ctx.run.mode==='paper')await this.pool.query("UPDATE live_orders SET status='cancelled',updated_at=now() WHERE run_id=$1 AND chain=$2 AND ca=$3 AND status='pending'",[ctx.run.id,ctx.watch.chain,ctx.watch.ca]);
   if(!valid())return;
   await this.seedAggregation(ctx,boundary,valid);
   if(!valid())return;
   await this.pool.query("UPDATE live_watches SET status=CASE WHEN exit_only THEN 'pending_eviction' ELSE 'monitoring' END,recovery_reason=CASE WHEN exit_only THEN '低市值：只允许退出，仓位及订单结清后移除' ELSE NULL END WHERE run_id=$1 AND chain=$2 AND ca=$3",[ctx.run.id,ctx.watch.chain,ctx.watch.ca]);
   if(!valid())return;
   if(![...this.watches.values()].some(other=>other!==ctx&&other.ready&&other.watch.chain===ctx.watch.chain&&other.watch.pair_id===ctx.watch.pair_id))
    this.aggregator.markClosedThrough(ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,boundary);
   ctx.noOrdersBefore=boundary;ctx.ready=true;ctx.watch.status=ctx.watch.exit_only?'pending_eviction':'monitoring';
  }catch(e){if(valid())await this.markRecovering(ctx,`补行情失败，稍后重试：${redact(e)}`,60_000);}
 }
 private async seedAggregation(ctx:Context,boundary=ctx.noOrdersBefore,valid=()=>true){
  if([...this.watches.values()].some(other=>other!==ctx&&other.ready&&other.watch.chain===ctx.watch.chain&&other.watch.pair_id===ctx.watch.pair_id&&other.run.interval===ctx.run.interval))return;
  const last=ctx.evaluator.state.history.at(-1);if(!last)return;
  const rows=(await this.pool.query('SELECT type,close FROM meme_kline WHERE chain=$1 AND pair_id=$2 AND interval=$3 AND open_time=$4 AND valid IS DISTINCT FROM false',[ctx.watch.chain,ctx.watch.pair_id,ctx.run.interval,last.time])).rows;
  if(!valid())return;
  const price=Number(rows.find(r=>r.type==='price')?.close),mcap=Number(rows.find(r=>r.type==='mcap')?.close);
  if(!Number.isFinite(price)||price<=0 || (ctx.run.value_type==='mcap'&&(!Number.isFinite(mcap)||mcap<=0)))return; // First reliable socket pair will seed instead.
  const step=ctx.run.interval==='30s'?30_000:60_000,first=Math.ceil(boundary/step)*step;
  for(const type of ['price','mcap'] as const){const value=type==='price'?price:mcap;if(!Number.isFinite(value)||value<=0)continue;
   this.aggregator.seed({symbol:{chain:ctx.watch.chain,ca:ctx.watch.ca,pairId:ctx.watch.pair_id},interval:ctx.run.interval,type,tradeCount:0,closeTradeId:`recovery:${last.time}`,closeTradeTime:last.closeTime,
    candle:{time:first-step,closeTime:first,open:value,high:value,low:value,close:value,volume:0,synthetic:true,valid:true}});
  }
 }
 private async evictOrRetain(ctx:Context,reason:string){
  if(ctx.run.mode==='paper')await this.pool.query("UPDATE live_orders SET status='cancelled',updated_at=now() WHERE run_id=$1 AND chain=$2 AND ca=$3 AND side='buy' AND status='pending'",[ctx.run.id,ctx.watch.chain,ctx.watch.ca]);
  const held=!!ctx.evaluator.state.position,pending=await this.pending(ctx);
  const status=held||pending?'pending_eviction':'evicted_low_mcap';
  ctx.watch.status=status;ctx.watch.exit_only=true;
  await this.pool.query('UPDATE live_watches SET exit_only=true,status=$4,recovery_reason=$5 WHERE run_id=$1 AND chain=$2 AND ca=$3',[ctx.run.id,ctx.watch.chain,ctx.watch.ca,status,reason]);
  if(status==='evicted_low_mcap'){
   this.watches.delete(watchKey(ctx.run.id,ctx.watch.chain,ctx.watch.ca));
   await this.pool.query("INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_time,payload) VALUES($1,$2,$3,$4,'watch_evicted',$5,$6)",[ctx.run.id,ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,Date.now(),JSON.stringify({reason})]);
  }
 }
 private async recheckMarketCaps(){
  const groups=new Map<string,Context[]>();
  for(const ctx of this.watches.values()){
   const last=Number(ctx.watch.last_trade_at??0);if(last&&Date.now()-last<60_000)continue;
   const key=`${ctx.watch.chain}:${ctx.watch.ca}`;groups.set(key,[...(groups.get(key)??[]),ctx]);
  }
  for(const contexts of groups.values()){
   if(this.stopped)return;
   const first=contexts[0]!;
   let latest=this.latestCaps.get(projectKey(first.watch));
   if(!latest||Date.now()-latest.time>60_000){
    try{const info=await this.projects.fresh(first.watch);if(info.marketCap==null)continue;latest={value:info.marketCap,pairId:info.pairId,time:info.fetchedAt};}
    catch{continue;} // Missing/failed lookup is never zero market cap.
    await wait(250);
   }
   const cap=latest;
   this.enqueue(async()=>{if(this.stopped)return;for(const ctx of contexts){
    if(this.watches.get(watchKey(ctx.run.id,ctx.watch.chain,ctx.watch.ca))!==ctx||ctx.watch.pair_id!==cap.pairId)continue;
    const tick=this.latestCaps.get(projectKey(ctx.watch));const value=tick&&tick.time>cap.time?tick.value:cap.value;
    ctx.watch.current_mcap=String(value);
    await this.pool.query('UPDATE live_watches SET current_mcap=$4,mcap_checked_at=now() WHERE run_id=$1 AND chain=$2 AND ca=$3',[ctx.run.id,ctx.watch.chain,ctx.watch.ca,value]);
    if(value<Number(ctx.watch.exit_market_cap??MIN_MARKET_CAP))await this.evictOrRetain(ctx,`市值复查低于 ${ctx.watch.exit_market_cap??MIN_MARKET_CAP} USD`);
   }});
  }
 }
 private bump(runId:string,field:'late'|'closed'|'tooOld'|'reconnect'|'lastTradeAt',time=0){
  const item=this.telemetry.get(runId)??{late:0,dropped:0,closed:0,tooOld:0,reconnect:0,lastTradeAt:0};
  if(field==='lastTradeAt')item.lastTradeAt=Math.max(item.lastTradeAt,time);else item[field]++;
  if(field==='closed'||field==='tooOld')item.dropped++;
  this.telemetry.set(runId,item);
 }
 private async flushTelemetry(){
  for(const [runId,item] of this.telemetry){
   await this.pool.query(`UPDATE live_runs SET late_trade_count=late_trade_count+$2,dropped_trade_count=dropped_trade_count+$3,
    reconnect_count=reconnect_count+$4,last_trade_at=GREATEST(COALESCE(last_trade_at,0),$5) WHERE id=$1`,[runId,item.late,item.dropped,item.reconnect,item.lastTradeAt]);
   for(const [reason,count] of [['closed',item.closed],['too_old',item.tooOld]] as const)if(count)await this.pool.query("INSERT INTO live_events(run_id,kind,event_time,payload) VALUES($1,'late_trade_dropped',$2,$3)",[runId,Date.now(),JSON.stringify({reason,count})]);
   this.telemetry.delete(runId);
  }
  for(const key of this.dirtyWatches){const ctx=this.watches.get(key);if(!ctx?.watch.last_trade_at){this.dirtyWatches.delete(key);continue;}
   await this.pool.query('UPDATE live_watches SET last_trade_at=$4,current_mcap=COALESCE($5,current_mcap) WHERE run_id=$1 AND chain=$2 AND ca=$3',[ctx.run.id,ctx.watch.chain,ctx.watch.ca,ctx.watch.last_trade_at,ctx.watch.current_mcap??null]);
   this.dirtyWatches.delete(key);
  }
 }
 private async reconcileOrders(){
  if(!this.xxyy)return;
  const rows=(await this.pool.query(`SELECT o.id,o.run_id,o.tx_id,o.chain,o.ca,r.wallet_address
   FROM live_orders o JOIN live_runs r ON r.id=o.run_id WHERE r.mode='live' AND r.status='running' AND o.status IN ('submitted','unknown') AND o.tx_id IS NOT NULL ORDER BY o.reconcile_checked_at NULLS FIRST,o.created_at LIMIT 1`)).rows;
  for(const order of rows){
   try{
    await this.pool.query('UPDATE live_orders SET reconcile_checked_at=now() WHERE id=$1',[order.id]);
    const result=await this.xxyy.query(order.tx_id);
    const wallet=await this.xxyy.walletInfo(order.chain,order.wallet_address,order.ca);
    if(!result||!wallet||String(wallet.address??'').toLowerCase()!==String(order.wallet_address).toLowerCase())continue;
    // The trade API must provide a final state and an attributable fill. Until then
    // keep the execution hold; never infer a fill from a submitted txId alone.
    if(result.status==='failed'||result.status==='reverted'){
     await this.pool.query("UPDATE live_orders SET status='failed',raw_result=$2,updated_at=now() WHERE id=$1",[order.id,JSON.stringify({status:result.status,txId:order.tx_id})]);
     await this.pool.query("UPDATE live_runs SET execution_hold_reason=NULL WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM live_orders WHERE run_id=$1 AND status IN ('submitted','unknown'))",[order.run_id]);
    }
   }catch(e){console.error('XXYY 订单核验:',redact(e));}
  }
 }
 private async pending(ctx:Context){return !!(await this.db.query("SELECT 1 FROM live_orders WHERE run_id=$1 AND chain=$2 AND ca=$3 AND status IN ('pending','submitted','unknown') LIMIT 1",[ctx.run.id,ctx.watch.chain,ctx.watch.ca])).rowCount;}
 private async createDecision(ctx:Context,d:LiveDecision,bar:ClosedMarketBar,price:ClosedMarketBar){
  if(ctx.run.status!=='running'||!ctx.ready||ctx.run.execution_hold_reason||!this.connected.has(pairKey(ctx.watch.chain,ctx.watch.pair_id)))return;
  const key=createHash('sha256').update(`${ctx.run.id}:${ctx.watch.chain}:${ctx.watch.ca}:${d.side}:${d.reason}:${d.time}`).digest('hex');
  const cfg=ctx.run.strategy_json,position=ctx.evaluator.state.position;
  if(d.side==='buy'){
   if(ctx.watch.exit_only||ctx.watch.status==='pending_eviction'||d.time<=Number(ctx.watch.signal_time))return;
   const exitCap=effectiveExitCap(selectedProjectSources(ctx.run),ctx.watch.matched_sources??['memeinfo']);
   if(ctx.watch.current_mcap!=null&&Number(ctx.watch.current_mcap)<exitCap)return;
   const active=[...this.watches.values()].filter(x=>x.run.id===ctx.run.id&&x.evaluator.state.position).length+this.submissions.filter(x=>x.ctx.run.id===ctx.run.id&&x.decision.side==='buy'&&!x.ctx.evaluator.state.position).length;
   if(!position && active>=cfg.positionConfig.maxConcurrentPositions)return;
  }
  const available=Number(ctx.run.cash);
  const sizing=cfg.positionConfig.sizing;
  const amount=d.side==='sell'?ctx.run.mode==='live'?100:position?.quantity??0:
   ctx.run.mode==='live'?Number(ctx.run.risk_json?.maxOrderNative):
   sizing.type==='fixed_amount'?Math.min(sizing.value,available):available*sizing.value/100;
  if(!Number.isFinite(amount)||amount<=0)return;
  if(ctx.run.mode==='live' && (process.env.LIVE_TRADING_ENABLED!=='true'||!this.xxyy||ctx.run.chain==='robin'))return;
  const evidence={impulse:d.impulse??position?.impulse??null,executionVersion:LIVE_EXECUTION_VERSION,candle:bar.candle,priceCandle:price.candle,marketCapBasis:bar.marketCapBasis,derivedSupply:bar.derivedSupply,hasDerivedMarketCap:bar.hasDerivedMarketCap,stop:d.stop,target:d.target,lockPrice:position?.lockPrice,lockTier:position?.lockTier,cost:position?.entryPrice,referenceValue:d.value,observedAt:Date.now(),simulatedConversion:ctx.run.value_type==='mcap',priceBasis:'paired_bar_close_ratio'};
  const result=await this.db.query(`INSERT INTO live_orders(run_id,chain,ca,pair_id,intent_key,side,reason,status,decision_time,decision_value,requested_amount,raw_result,position_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$12) ON CONFLICT(intent_key) DO NOTHING RETURNING id`,[ctx.run.id,ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,key,d.side,d.reason,d.time,d.value,amount,JSON.stringify(evidence),position?.positionId??null]);
  if(!result.rowCount)return;
  await this.db.query("INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_key,event_time,payload) VALUES($1,$2,$3,$4,'decision',$5,$6,$7) ON CONFLICT(event_key) DO NOTHING",[ctx.run.id,ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,`decision:${key}`,d.time,JSON.stringify({side:d.side,reason:d.reason,value:d.value,...evidence})]);
  if(ctx.run.mode==='live')this.submissions.push({ctx,id:result.rows[0].id,decision:d,amount});
  else{
   const fillPrice=simulatedBarPrice(ctx.run.value_type,d.value,bar,price);
   if(fillPrice===undefined)throw new Error('模拟成交缺少可靠配对K线');
   await this.paperFill(ctx,{id:result.rows[0].id,side:d.side,reason:d.reason,requested_amount:amount,raw_result:evidence,decision_time:d.time,position_id:position?.positionId},
    {id:result.rows[0].id,chain:ctx.watch.chain,ca:ctx.watch.ca,pairId:ctx.watch.pair_id,time:d.time,price:fillPrice,mcap:ctx.run.value_type==='mcap'?d.value:undefined,volumeUsd:0});
  }
 }
 private async paperFill(ctx:Context,o:any,trade:MarketTrade){
  if(ctx.run.value_type==='mcap'&&(!trade.mcap||trade.mcap<=0))return;
  if(!this.executionClient)throw new Error('模拟成交必须在收盘事务内执行');
  const s=structuredClone(ctx.evaluator.state),cfg=ctx.run.strategy_json.executionConfig;
  const feeRate=cfg.feePercent/100,slipRate=cfg.slippagePercent/100,taxRate=(o.side==='buy'?cfg.buyTaxPercent:cfg.sellTaxPercent)/100;
  let quantity:number,gross:number,fee:number,slip:number,tax:number,newCash:number,newPnl=Number(ctx.run.realized_pnl??0);
  if(o.side==='buy'){
   gross=Math.min(Number(o.requested_amount),Number(ctx.run.cash)/(1+feeRate+slipRate+taxRate));
   if(!Number.isFinite(gross)||gross<=0)return;
   quantity=gross/trade.price;
   fee=gross*feeRate;slip=gross*slipRate;tax=gross*taxRate;newCash=Number(ctx.run.cash)-gross-fee-slip-tax;
   const value=ctx.run.value_type==='price'?trade.price:trade.mcap;
   if(!value || value<=0)return;
   if(s.position){const p=s.position,total=p.quantity+quantity;p.entryPrice=(p.entryPrice*p.quantity+value*quantity)/total;p.quantity=total;p.entries++;p.costBasisUsd=(p.costBasisUsd??0)+gross+fee+slip+tax;}
   else{const impulse=o.raw_result?.impulse??detectImpulseAtDecision(ctx,o.decision_time);if(!impulse)throw new Error('模拟订单缺少可核验拉升依据');s.position={entryPrice:value,quantity,entries:1,entryTime:trade.time,entryBar:s.history.length-1,impulse,tradeNo:s.trades+1,costBasisUsd:gross+fee+slip+tax,positionId:o.id};}
  }else{
   if(!s.position)return;quantity=Math.min(s.position.quantity,Number(o.requested_amount));gross=quantity*trade.price;
   fee=gross*feeRate;slip=gross*slipRate;tax=gross*taxRate;newCash=Number(ctx.run.cash)+gross-fee-slip-tax;
   const basis=(s.position.costBasisUsd??0)*(quantity/s.position.quantity);newPnl+=gross-fee-slip-tax-basis;
   s.position.quantity-=quantity;s.position.costBasisUsd=(s.position.costBasisUsd??0)-basis;
   if(s.position.quantity<=1e-12){s.position=undefined;s.trades++;s.lastEntryMatch=true;}
  }
  const c=this.executionClient;
   const claimed=await c.query("UPDATE live_orders SET status='filled',updated_at=now() WHERE id=$1 AND status='pending' RETURNING id",[o.id]);
   if(!claimed.rowCount)throw new Error('模拟订单重复成交');
   if(o.side==='buy'&&!ctx.evaluator.state.position&&s.position?.impulse)
    await c.query("UPDATE live_orders SET raw_result=jsonb_set(COALESCE(raw_result,'{}'::jsonb),'{impulse}',$2::jsonb) WHERE id=$1",[o.id,JSON.stringify(s.position.impulse)]);
   const fillValue=ctx.run.value_type==='price'?trade.price:trade.mcap!;
   await c.query("INSERT INTO live_fills(order_id,fill_time,fill_price,fill_value,quantity,gross_amount,fee,slippage_cost,tax_cost,market_cap,raw_result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[o.id,trade.time,trade.price,fillValue,quantity,gross,fee,slip,tax,trade.mcap??null,JSON.stringify({executionVersion:LIVE_EXECUTION_VERSION,simulated:true,priceBasis:ctx.run.value_type==='mcap'?'paired_bar_close_ratio':'bar_matching_value',observedAt:Date.now()})]);
   if(o.side==='buy'&&!o.position_id&&!ctx.evaluator.state.position)await c.query('UPDATE live_orders SET position_id=$2 WHERE id=$1',[o.id,o.id]);
   await c.query('UPDATE live_runs SET cash=$2,realized_pnl=$3,updated_at=now() WHERE id=$1',[ctx.run.id,newCash,newPnl]);
   await c.query('UPDATE live_watches SET state_json=$2 WHERE run_id=$1 AND chain=$3 AND ca=$4',[ctx.run.id,JSON.stringify(s),ctx.watch.chain,ctx.watch.ca]);
   await c.query("INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_key,event_time,payload) VALUES($1,$2,$3,$4,'fill',$5,$6,$7) ON CONFLICT(event_key) DO NOTHING",[ctx.run.id,ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,`fill:${o.id}`,trade.time,JSON.stringify({side:o.side,reason:o.reason,price:trade.price,value:fillValue,quantity})]);
   Object.assign(ctx.evaluator.state,s);ctx.run.cash=String(newCash);ctx.run.realized_pnl=String(newPnl);
 }
 private async submitLive(ctx:Context,orderId:string,d:LiveDecision,amount:number){
  const current=(await this.pool.query('SELECT status,execution_hold_reason FROM live_runs WHERE id=$1',[ctx.run.id])).rows[0];
  if(!current||current.status!=='running'||current.execution_hold_reason||this.stopped||!ctx.ready||!this.connected.has(pairKey(ctx.watch.chain,ctx.watch.pair_id))){
   await this.pool.query("UPDATE live_orders SET status='cancelled',updated_at=now() WHERE id=$1 AND status='pending'",[orderId]);return;
  }
  const risk=ctx.run.risk_json;
  if(d.side==='buy' && (!risk||amount>risk.maxOrderNative||Number(ctx.run.realized_pnl??0)<=-risk.maxDailyLossUsd)){
   await this.pool.query("UPDATE live_orders SET status='failed',updated_at=now() WHERE id=$1",[orderId]);return;
  }
  try{
   if(d.side==='buy'){
    // Conservative upper bound: no native-coin exposure is released until an
    // independently verified sell and wallet reconciliation are recorded.
    const spent=Number((await this.pool.query("SELECT COALESCE(SUM(requested_amount),0) AS amount FROM live_orders WHERE run_id=$1 AND side='buy' AND status IN ('submitted','filled','unknown')",[ctx.run.id])).rows[0]?.amount??0);
    if(spent+amount>risk.maxTotalNative)throw new Error('实盘总敞口上限已触及');
   }
   const wallet=await this.xxyy!.walletInfo(ctx.run.chain as 'sol'|'bsc',ctx.run.wallet_address!,d.side==='sell'?ctx.watch.ca:undefined);
   if(!wallet||String(wallet.address??'').toLowerCase()!==ctx.run.wallet_address!.toLowerCase())throw new Error('XXYY 钱包身份无法核对');
   if(d.side==='buy'&&(!Number.isFinite(Number(wallet.balance))||Number(wallet.balance)<amount+(ctx.run.chain==='sol'?risk.tip:0)))throw new Error('XXYY 钱包余额不足或不可验证');
   if(d.side==='sell'&&(!Number.isFinite(Number(wallet.tokenBalance?.uiAmount))||Number(wallet.tokenBalance.uiAmount)<=0))throw new Error('XXYY 钱包代币持仓不可验证');
  }catch(e){
   await this.pool.query("UPDATE live_orders SET status='failed',updated_at=now() WHERE id=$1",[orderId]);
   await this.pool.query("INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_time,payload) VALUES($1,$2,$3,$4,'order_rejected',$5,$6)",[ctx.run.id,ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,Date.now(),JSON.stringify({reason:`实盘下单前核验失败：${redact(e)}`})]);
   return;
  }
  let txId:string|undefined;
  if(this.stopped||!ctx.ready||!this.connected.has(pairKey(ctx.watch.chain,ctx.watch.pair_id))){await this.pool.query("UPDATE live_orders SET status='cancelled',raw_result=COALESCE(raw_result,'{}'::jsonb)||$2::jsonb,updated_at=now() WHERE id=$1 AND status='pending'",[orderId,JSON.stringify({cancelReason:'提交前行情中断；本订单未发送'})]);return;}
  try{
   txId=await this.xxyy!.swap({chain:ctx.run.chain as 'sol'|'bsc',walletAddress:ctx.run.wallet_address!,tokenAddress:ctx.watch.ca,isBuy:d.side==='buy',amount,tip:risk.tip,slippage:risk.slippagePercent});
   await this.pool.query("UPDATE live_orders SET status='submitted',tx_id=$2,updated_at=now() WHERE id=$1",[orderId,txId]);
   // The API's response has native-token amounts but not a verified USD fill or fees.
   // Until reconciliation is implemented, do not infer a position or send another order.
   ctx.run.execution_hold_reason='链上订单已提交，等待核对交易和钱包';
   await this.pool.query("UPDATE live_runs SET execution_hold_reason=$2,updated_at=now() WHERE id=$1",[ctx.run.id,ctx.run.execution_hold_reason]);
  }catch(e){
   await this.pool.query("UPDATE live_orders SET status='unknown',tx_id=COALESCE(tx_id,$2),updated_at=now() WHERE id=$1",[orderId,txId??null]);
   ctx.run.execution_hold_reason='XXYY 下单结果未知，禁止新订单与重试；等待交易及钱包核对';
   await this.pool.query("UPDATE live_runs SET execution_hold_reason=$2,updated_at=now() WHERE id=$1",[ctx.run.id,ctx.run.execution_hold_reason]);
   console.error('XXYY order needs reconciliation:',redact(e));
  }
 }
}

function detectImpulseAtDecision(ctx:Context,decisionTime:number){
 const history=ctx.evaluator.state.history.filter(c=>c.closeTime<=decisionTime);
 // A decision's selected impulse should be saved with the order; this fallback is only
 // used in paper mode after a restart and never authorizes a retroactive entry.
 const {impulseCondition}=ctx.run.strategy_json;
 return history.length?detectImpulse(history,impulseCondition):undefined;
}
