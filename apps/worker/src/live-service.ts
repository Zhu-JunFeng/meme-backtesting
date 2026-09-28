import {createHash} from 'node:crypto';
import {io,type Socket} from 'socket.io-client';
import WebSocket from 'ws';
import type {Pool,PoolClient} from 'pg';
import {LiveCandleAggregator,LiveEvaluator,detectImpulse,type ClosedMarketBar,type LiveDecision,type MarketTrade} from '@meme/engine';
import type {Candle,StrategyConfig} from '@meme/domain';
import {parseMarketTrades,parseProjectSignal,resolveLivePool,type ProjectSignal} from './live-input.js';

type Run={id:string;mode:'paper'|'live';chain:string;signal_source:string;interval:'30s'|'1m';value_type:'price'|'mcap';status:string;execution_hold_reason:string|null;strategy_json:StrategyConfig;cash:string;realized_pnl:string;wallet_address:string|null;risk_json:any;started_at:Date};
type Watch={run_id:string;chain:string;ca:string;pair_id:string;dex_id:string|null;signal_time:string;state_json:any;last_candle_time:string|null;status:string;current_mcap:string|null;last_trade_at:string|null};
type Context={run:Run;watch:Watch;evaluator:LiveEvaluator;ready:boolean;nextRecoveryAt:number;noOrdersBefore:number};
const watchKey=(r:string,c:string,a:string)=>`${r}:${c}:${a}`;
const pairKey=(c:string,p:string)=>`${c}:${p.toLowerCase()}`;
export const LIVE_CA_LIMIT=20,MIN_MARKET_CAP=50_000;
export const eligibleMarketCap=(value:unknown)=>Number.isFinite(Number(value))&&value!==null&&value!==undefined&&Number(value)>=MIN_MARKET_CAP;
export const canMonitor=(active:number,existing:boolean)=>existing||active<LIVE_CA_LIMIT;
export function* backfillWindows(from:number,to:number,step:number):Generator<{from:number;to:number}>{
 if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||!Number.isSafeInteger(step)||step<=0||from%step!==0||to%step!==0||to<from)throw new Error('补行情时间范围无效');
 for(let start=from;start<to;start+=step*5000)yield {from:start,to:Math.min(to,start+step*5000)};
}
export const acceptsNewSignal=(run:{signal_source:string;started_at:Date|string},signal:ProjectSignal)=>
 (run.signal_source==='all'||run.signal_source===signal.source)&&signal.time>new Date(run.started_at).getTime();
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
 private readonly aggregator=new LiveCandleAggregator(bar=>this.enqueue(()=>this.onBar(bar)));
 private readonly watches=new Map<string,Context>();
 private readonly sockets=new Map<string,Socket>();
 private readonly connected=new Set<string>();
 private readonly telemetry=new Map<string,{late:number;dropped:number;closed:number;tooOld:number;reconnect:number;lastTradeAt:number}>();
 private readonly dirtyWatches=new Set<string>();
 private lastMcapCheck=0;
 private signal?:WebSocket;private lock?:PoolClient;private refreshTimer?:ReturnType<typeof setInterval>;private flushTimer?:ReturnType<typeof setInterval>;
 private chain=Promise.resolve();private stopped=false;private feedHealthy=false;
 private readonly xxyy=process.env.XXYY_API_KEY?new XxyyTradeClient(process.env.XXYY_API_KEY):undefined;
 constructor(private readonly pool:Pool){}
 private enqueue(fn:()=>Promise<void>){this.chain=this.chain.then(fn).catch(e=>console.error('live service:',redact(e)));}
 async start(){
  if(!process.env.MEMEINFO_SIGNAL_TOKEN){console.log('live service disabled: signal feed token missing');return;}
  const client=await this.pool.connect();
  const locked=(await client.query('SELECT pg_try_advisory_lock(63920924) AS acquired')).rows[0]?.acquired;
  if(!locked){client.release();console.log('live service standby: another owner holds advisory lock');return;}
  this.lock=client;
  await this.refresh();this.connectSignals();
  this.refreshTimer=setInterval(()=>this.enqueue(()=>this.refresh()),5_000);
  this.flushTimer=setInterval(()=>this.aggregator.flush(Date.now()),1_000);
  console.log('live service started; real orders',process.env.LIVE_TRADING_ENABLED==='true'?'armed by server configuration':'disabled');
 }
 async close(){this.stopped=true;if(this.refreshTimer)clearInterval(this.refreshTimer);if(this.flushTimer)clearInterval(this.flushTimer);this.signal?.close();for(const socket of this.sockets.values()){socket.removeAllListeners();socket.disconnect();}await this.chain;await this.flushTelemetry();if(this.lock){await this.lock.query('SELECT pg_advisory_unlock(63920924)');this.lock.release();}}
 private async refresh(){
  if(this.stopped)return;
  const rows=(await this.pool.query("SELECT * FROM live_runs WHERE status='running'")).rows as Run[];
  const active=new Set(rows.map(r=>r.id));
  const watchRows=(await this.pool.query("SELECT w.* FROM live_watches w JOIN live_runs r ON r.id=w.run_id WHERE r.status='running' AND w.status IN ('monitoring','recovering','pending_eviction')")).rows as Watch[];
  const runMap=new Map(rows.map(r=>[r.id,r]));
  for(const w of watchRows){const key=watchKey(w.run_id,w.chain,w.ca);const old=this.watches.get(key);if(old){old.run=runMap.get(w.run_id)!;old.watch={...w,last_trade_at:old.watch.last_trade_at??w.last_trade_at,current_mcap:old.watch.current_mcap??w.current_mcap};continue;}
   const run=runMap.get(w.run_id);if(!run)continue;
   const ctx:Context={run,watch:w,evaluator:new LiveEvaluator(run.strategy_json,Number(w.signal_time),w.state_json?.history?w.state_json:undefined),ready:false,nextRecoveryAt:0,noOrdersBefore:Date.now()};
   this.watches.set(key,ctx);
   await this.markRecovering(ctx,'服务启动，等待行情订阅并补数');
  }
  for(const [key,ctx] of this.watches)if(!active.has(ctx.run.id)||!watchRows.some(w=>watchKey(w.run_id,w.chain,w.ca)===key))this.watches.delete(key);
  const required=new Map([...this.watches.values()].map(ctx=>[pairKey(ctx.watch.chain,ctx.watch.pair_id),ctx.watch]));
  for(const [key,watch] of required)if(!this.sockets.has(key))this.subscribe(watch);
  for(const [key,socket] of this.sockets)if(!required.has(key)){socket.removeAllListeners();socket.disconnect();this.sockets.delete(key);this.connected.delete(key);const [chain,pairId]=key.split(':');this.aggregator.discardPair(chain,pairId);}
  for(const ctx of this.watches.values())if(!ctx.ready&&(!ctx.watch.dex_id||this.connected.has(pairKey(ctx.watch.chain,ctx.watch.pair_id)))&&Date.now()>=ctx.nextRecoveryAt)await this.recover(ctx);
  if(Date.now()-this.lastMcapCheck>=60_000){this.lastMcapCheck=Date.now();await this.recheckMarketCaps();}
  await this.reconcileOrders();
  await this.flushTelemetry();
  await this.pool.query(`UPDATE live_runs r SET feed_state=CASE
   WHEN EXISTS(SELECT 1 FROM live_watches w WHERE w.run_id=r.id AND w.status='recovering') THEN 'recovering'
   WHEN EXISTS(SELECT 1 FROM live_watches w WHERE w.run_id=r.id AND w.status IN ('monitoring','pending_eviction')) THEN 'connected'
   ELSE 'connecting' END,
   feed_reason=CASE WHEN EXISTS(SELECT 1 FROM live_watches w WHERE w.run_id=r.id AND w.status='recovering') THEN feed_reason ELSE NULL END
   WHERE r.status='running'`);
  if(rows.length)await this.pool.query("UPDATE live_runs SET heartbeat_at=now() WHERE status='running'");
 }
 private connectSignals(){
  if(this.stopped)return;
  const ws=new WebSocket(process.env.MEMEINFO_SIGNAL_URL??'wss://app.memeinfo.net/api/ws/external/signal-events',{headers:{Authorization:`Bearer ${process.env.MEMEINFO_SIGNAL_TOKEN}`}});
  this.signal=ws;
  ws.on('open',()=>{this.feedHealthy=true;});
  ws.on('message',raw=>{const signal=parseProjectSignal(raw.toString());if(signal)this.enqueue(()=>this.onSignal(signal));});
  ws.on('close',()=>{this.feedHealthy=false;if(!this.stopped)setTimeout(()=>this.connectSignals(),3_000);});
  ws.on('error',error=>console.error('MemeInfo signal connection:',redact(error)));
 }
 private async lookup(signal:ProjectSignal){
  const response=await fetch('https://app.memeinfo.net/api/projects/lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caList:[signal.ca],symbolList:['']}),signal:AbortSignal.timeout(10_000)});
  if(!response.ok)throw new Error(`MemeInfo lookup HTTP ${response.status}`);
  const data=await response.json() as any;
  const item=(data?.data?.caListTokenList??[]).find((p:any)=>String(p.chain??'').toLowerCase()===signal.chain && (signal.chain==='sol'?p.token_address===signal.ca:String(p.token_address??'').toLowerCase()===signal.ca));
  return resolveLivePool(item);
 }
 private async onSignal(signal:ProjectSignal){
  if(!this.feedHealthy||signal.time>Date.now()+5_000)return;
  const runs=(await this.pool.query("SELECT id,signal_source,started_at FROM live_runs WHERE status='running' AND chain=$1 AND started_at IS NOT NULL AND signal_source IN ('all',$2)",[signal.chain,signal.source])).rows;
  const relevant=runs.filter(r=>acceptsNewSignal(r,signal));
  if(!relevant.length)return;
  const capacities=(await this.pool.query(`SELECT r.id,COUNT(w.*) FILTER(WHERE w.status IN ('monitoring','recovering','pending_eviction'))::int AS active,
   BOOL_OR(w.ca=$2 AND w.status IN ('monitoring','recovering','pending_eviction')) AS existing
   FROM live_runs r LEFT JOIN live_watches w ON w.run_id=r.id WHERE r.id=ANY($1::uuid[]) GROUP BY r.id`,[relevant.map(r=>r.id),signal.ca])).rows;
  if(!capacities.some(r=>canMonitor(Number(r.active),!!r.existing))){
   await this.pool.query("INSERT INTO live_events(chain,ca,kind,event_time,payload) VALUES($1,$2,'signal_skipped',$3,$4)",[signal.chain,signal.ca,signal.time,JSON.stringify({reason:'all_matching_runs_full',limit:LIVE_CA_LIMIT})]);return;
  }
  const pool=await this.lookup(signal);
  if(!pool){await this.pool.query("INSERT INTO live_events(chain,ca,kind,event_time,payload) VALUES($1,$2,'lookup_unmatched',$3,$4)",[signal.chain,signal.ca,signal.time,JSON.stringify({source:signal.source})]);return;}
  if(!eligibleMarketCap(pool.marketCap)){
   await this.pool.query("INSERT INTO live_events(chain,ca,pair_id,kind,event_time,payload) VALUES($1,$2,$3,'signal_skipped',$4,$5)",[signal.chain,signal.ca,pool.pairId,signal.time,JSON.stringify({reason:'market_cap_below_threshold_or_missing',marketCap:pool.marketCap??null})]);return;
  }
  const {pairId,dexId}=pool;
  const c=await this.pool.connect();
  try{await c.query('BEGIN');
   // Serialize admissions per run; concurrent signals cannot each claim the last slot.
   await c.query('SELECT id FROM live_runs WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[relevant.map(r=>r.id)]);
   await c.query(`INSERT INTO token_signal_events(chain,ca,signal_source,detail_id,signal_time,source_signal,provenance)
    VALUES($1,$2,$3,$4,$5,$6,'[]') ON CONFLICT(chain,ca,signal_source,detail_id) DO NOTHING`,[signal.chain,signal.ca,signal.source,signal.key,signal.time,JSON.stringify(signal.identity)]);
   await c.query(`INSERT INTO token_info(chain,ca,pair,signal_source,source_signal,signal_time) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(chain,ca,pair) DO UPDATE SET signal_source=CASE WHEN token_info.signal_time IS NULL OR EXCLUDED.signal_time<token_info.signal_time THEN EXCLUDED.signal_source ELSE token_info.signal_source END,
    source_signal=CASE WHEN token_info.signal_time IS NULL OR EXCLUDED.signal_time<token_info.signal_time THEN EXCLUDED.source_signal ELSE token_info.source_signal END,
    signal_time=LEAST(COALESCE(token_info.signal_time,EXCLUDED.signal_time),EXCLUDED.signal_time)`,[signal.chain,signal.ca,pairId,signal.source,JSON.stringify(signal.identity),signal.time]);
   for(const r of relevant){
    const active=Number((await c.query("SELECT COUNT(*) AS count FROM live_watches WHERE run_id=$1 AND status IN ('monitoring','recovering','pending_eviction')",[r.id])).rows[0].count);
    const prior=(await c.query('SELECT status,signal_key FROM live_watches WHERE run_id=$1 AND chain=$2 AND ca=$3',[r.id,signal.chain,signal.ca])).rows[0];
    if(prior?.status!=='evicted_low_mcap'&&prior){
     await c.query('UPDATE live_runs SET last_signal_at=GREATEST(COALESCE(last_signal_at,0),$2) WHERE id=$1',[r.id,signal.time]);
     await c.query("INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_key,event_time,payload) VALUES($1,$2,$3,$4,'external_signal',$5,$6,$7) ON CONFLICT(event_key) DO NOTHING",[r.id,signal.chain,signal.ca,pairId,`${r.id}:${signal.key}`,signal.time,JSON.stringify(signal.identity)]);
     continue;
    }
    if(!canMonitor(active,false)){await c.query("INSERT INTO live_events(run_id,chain,ca,kind,event_time,payload) VALUES($1,$2,$3,'signal_skipped',$4,$5)",[r.id,signal.chain,signal.ca,signal.time,JSON.stringify({reason:'run_full',limit:LIVE_CA_LIMIT})]);continue;}
    if(prior?.signal_key===signal.key)continue;
    await c.query(`INSERT INTO live_watches(run_id,chain,ca,pair_id,dex_id,signal_source,signal_key,signal_time,status,state_json,last_candle_time,current_mcap,mcap_checked_at,recovery_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'recovering','{}',NULL,$9,now(),'新信号入组，预热指标')
      ON CONFLICT(run_id,chain,ca) DO UPDATE SET pair_id=EXCLUDED.pair_id,dex_id=EXCLUDED.dex_id,signal_source=EXCLUDED.signal_source,signal_key=EXCLUDED.signal_key,signal_time=EXCLUDED.signal_time,status='recovering',state_json='{}',last_candle_time=NULL,current_mcap=EXCLUDED.current_mcap,mcap_checked_at=now(),recovery_reason=EXCLUDED.recovery_reason`,[r.id,signal.chain,signal.ca,pairId,dexId,signal.source,signal.key,signal.time,pool.marketCap]);
    await c.query("UPDATE live_runs SET last_signal_at=GREATEST(COALESCE(last_signal_at,0),$2),feed_state='connecting' WHERE id=$1",[r.id,signal.time]);
    await c.query("INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_key,event_time,payload) VALUES($1,$2,$3,$4,'external_signal',$5,$6,$7) ON CONFLICT(event_key) DO NOTHING",[r.id,signal.chain,signal.ca,pairId,`${r.id}:${signal.key}`,signal.time,JSON.stringify(signal.identity)]);
   }
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  await this.refresh();
 }
 private subscribe(watch:Watch){
  if(!watch.dex_id)return;
  const template=process.env.XXYY_TRADE_CHANNEL_TEMPLATE||'D_TOKEN_DETAIL_{dexId}_{pairId}';
  if(!template.includes('{pairId}')||!template.includes('{dexId}'))throw new Error('XXYY_TRADE_CHANNEL_TEMPLATE 必须包含 {pairId} 和 {dexId}');
  const channel=template.replaceAll('{pairId}',watch.pair_id).replaceAll('{dexId}',watch.dex_id).replaceAll('{chain}',watch.chain),event=process.env.XXYY_TRADE_EVENT||'NEW_TRADE';
  const key=pairKey(watch.chain,watch.pair_id);
  const previous=this.sockets.get(key);if(previous){previous.removeAllListeners();previous.disconnect();this.connected.delete(key);}
  const socket=io(process.env.XXYY_PUSH_URL??'wss://web-push.xxyy.io/data',{transports:['websocket'],forceNew:true,reconnection:true});
  this.sockets.set(key,socket);
  socket.on('connect',()=>{this.connected.add(key);socket.emit('SUBSCRIBE',channel,{});this.enqueue(async()=>{for(const ctx of this.watches.values())if(pairKey(ctx.watch.chain,ctx.watch.pair_id)===key){ctx.ready=false;ctx.nextRecoveryAt=0;await this.markRecovering(ctx,'连接成功，补齐断线期间行情');}await this.refresh();});});
  socket.on('disconnect',()=>this.enqueue(()=>this.feedInterrupted(watch.chain,watch.pair_id)));
  socket.on(event,(raw,receivedChannel)=>{for(const trade of parseMarketTrades(raw,receivedChannel,channel,{chain:watch.chain,ca:watch.ca,pairId:watch.pair_id}))this.enqueue(()=>this.onTrade(trade));});
  socket.on('connect_error',error=>console.error('XXYY trade connection:',redact(error)));
 }
 private async feedInterrupted(chain:string,pairId:string){
  if(this.stopped)return;
  this.connected.delete(pairKey(chain,pairId));
  this.aggregator.discardPair(chain,pairId);
  const contexts=[...this.watches.values()].filter(c=>c.watch.chain===chain&&c.watch.pair_id===pairId);
  for(const ctx of contexts){ctx.ready=false;ctx.noOrdersBefore=Date.now();await this.markRecovering(ctx,'实时成交连接断开，自动重连中');if(ctx.run.mode==='paper')await this.pool.query("UPDATE live_orders SET status='cancelled',updated_at=now() WHERE run_id=$1 AND chain=$2 AND ca=$3 AND status='pending'",[ctx.run.id,ctx.watch.chain,ctx.watch.ca]);this.bump(ctx.run.id,'reconnect');}
 }
 private async onTrade(trade:MarketTrade){
  if(this.stopped || trade.time>Date.now()+5_000)return;
  const contexts=[...this.watches.values()].filter(c=>c.watch.chain===trade.chain&&c.watch.pair_id===trade.pairId&&c.run.status==='running');
  if(!contexts.length)return;
  const result=this.aggregator.acceptDetailed(trade);
  if(result.late)for(const ctx of contexts)this.bump(ctx.run.id,'late');
  if(!result.accepted){if(result.reason==='closed'||result.reason==='too_old')for(const ctx of contexts)this.bump(ctx.run.id,result.reason==='closed'?'closed':'tooOld');return;}
  if(result.late)return; // May update an open candle, but never simulate a fill or a tick exit.
  for(const ctx of contexts){
   if(trade.time<=Number(ctx.watch.last_trade_at??0))continue;
   ctx.watch.last_trade_at=String(trade.time);if(trade.mcap!==undefined)ctx.watch.current_mcap=String(trade.mcap);
   this.dirtyWatches.add(watchKey(ctx.run.id,ctx.watch.chain,ctx.watch.ca));
   this.bump(ctx.run.id,'lastTradeAt',trade.time);
   if(trade.mcap!==undefined&&trade.mcap<MIN_MARKET_CAP)await this.evictOrRetain(ctx,'实时市值低于 50,000 USD');
   if(ctx.watch.status==='evicted_low_mcap')continue;
   if(!ctx.ready)continue;
   if(ctx.run.value_type==='mcap'&&(!trade.mcap||trade.mcap<=0)){await this.markRecovering(ctx,'实时成交缺少可靠市值');continue;}
   ctx.evaluator.state.lastTokenPrice=trade.price;
   if(ctx.run.mode==='paper'&&trade.time>ctx.noOrdersBefore)await this.paperFill(ctx,trade);
   const decision=ctx.evaluator.onTrade(trade,ctx.run.value_type);
   if(decision && trade.time>ctx.noOrdersBefore && !await this.pending(ctx))await this.createDecision(ctx,decision);
  }
 }
 private async onBar(bar:ClosedMarketBar){
  let c=bar.candle;
  const inserted=await this.pool.query(`INSERT INTO meme_kline(chain,ca,pair_id,interval,open_time,close_time,open,high,low,close,volume,trade_count,type,source,raw_data,valid)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'xxyy_socket',$14,true)
    ON CONFLICT(chain,pair_id,interval,open_time,type) DO NOTHING RETURNING open_time`,
    [bar.symbol.chain,bar.symbol.ca,bar.symbol.pairId,bar.interval,c.time,c.closeTime,c.open,c.high,c.low,c.close,c.volume,bar.tradeCount,bar.type,JSON.stringify({feed:'xxyy_socket',closed:true})]);
  if(!inserted.rowCount){
   const existing=(await this.pool.query('SELECT open_time,close_time,open,high,low,close,volume,valid FROM meme_kline WHERE chain=$1 AND pair_id=$2 AND interval=$3 AND open_time=$4 AND type=$5',[bar.symbol.chain,bar.symbol.pairId,bar.interval,c.time,bar.type])).rows[0];
   if(!existing||existing.valid===false)return;
   c={time:Number(existing.open_time),closeTime:Number(existing.close_time),open:Number(existing.open),high:Number(existing.high),low:Number(existing.low),close:Number(existing.close),volume:Number(existing.volume)};
  }
  const contexts=[...this.watches.values()].filter(ctx=>ctx.run.status==='running'&&ctx.watch.chain===bar.symbol.chain&&ctx.watch.pair_id===bar.symbol.pairId&&ctx.run.interval===bar.interval&&ctx.run.value_type===bar.type);
  for(const ctx of contexts){
   if(!ctx.ready)continue;
   const decision=ctx.evaluator.onClosedCandle(c);
   if(decision && c.time>=ctx.noOrdersBefore && !await this.pending(ctx))await this.createDecision(ctx,decision);
   await this.pool.query('UPDATE live_watches SET state_json=$2,last_candle_time=$3 WHERE run_id=$1 AND chain=$4 AND ca=$5',[ctx.run.id,JSON.stringify(ctx.evaluator.snapshot()),c.time,ctx.watch.chain,ctx.watch.ca]);
   if(ctx.run.mode==='paper')await this.recordEquity(ctx.run,c.closeTime);
  }
 }
 private async recordEquity(run:Run,time:number){
  const watches=[...this.watches.values()].filter(c=>c.run.id===run.id),cash=Number(run.cash);
  const held=watches.reduce((sum,ctx)=>sum+(ctx.evaluator.state.position?.quantity??0)*(ctx.evaluator.state.lastTokenPrice??0),0);
  const basis=watches.reduce((sum,ctx)=>sum+(ctx.evaluator.state.position?.costBasisUsd??0),0);
  await this.pool.query(`INSERT INTO live_equity_curve(run_id,time,equity,cash,unrealized) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(run_id,time) DO UPDATE SET equity=EXCLUDED.equity,cash=EXCLUDED.cash,unrealized=EXCLUDED.unrealized`,[run.id,time,cash+held,cash,held-basis]);
 }
 private async catchup(ctx:Context){
  const step=ctx.run.interval==='30s'?30_000:60_000,to=Math.floor(Date.now()/step)*step;
  let from=ctx.watch.last_candle_time?Number(ctx.watch.last_candle_time)+step:to-600*step;
  if(from>=to)return;
  for(const window of backfillWindows(from,to,step)){
   const end=window.to;from=window.from;
   const response=await fetch('https://www.xxyy.io/api/data/candlestick/searchBarData',{method:'POST',headers:{'X-CHAIN':ctx.watch.chain,'X-VERSION':'1','X-LANGUAGE':'zh','Content-Type':'application/json'},body:JSON.stringify({pairId:ctx.watch.pair_id,valueType:ctx.run.value_type==='mcap'?'mc':'price',interval:step/1000,priceType:'usd',from,to:end,countBack:5000}),signal:AbortSignal.timeout(15_000)});
   if(!response.ok)throw new Error(`XXYY 历史补数 HTTP ${response.status}`);
   const data=await response.json() as any;if(data.code!==0||!Array.isArray(data.data))throw new Error('XXYY 历史补数响应无效');
   const rows=data.data.map((row:any)=>({time:Number(row.time),open:Number(row.price?.open),high:Number(row.price?.high),low:Number(row.price?.low),close:Number(row.price?.close),volume:Number(row.price?.volume)}))
    .filter((row:Candle)=>Number.isSafeInteger(row.time)&&row.time>=from&&row.time+step<=end&&row.time%step===0&&row.low>0&&row.high>=Math.max(row.open,row.close)&&row.low<=Math.min(row.open,row.close)&&row.volume>=0)
    .sort((a:Candle,b:Candle)=>a.time-b.time);
   for(let index=0;index<rows.length;index+=500){
    const batch=rows.slice(index,index+500);
    await this.pool.query(`INSERT INTO meme_kline(chain,ca,pair_id,interval,open_time,close_time,open,high,low,close,volume,trade_count,type,source,raw_data,valid)
     SELECT $1,$2,$3,$4,x.time,x.time+$5,x.open,x.high,x.low,x.close,x.volume,0,$6,'xxyy',null,true
     FROM jsonb_to_recordset($7::jsonb) AS x(time bigint,open numeric,high numeric,low numeric,close numeric,volume numeric)
     ON CONFLICT(chain,pair_id,interval,open_time,type) DO NOTHING`,[ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,ctx.run.interval,step,ctx.run.value_type,JSON.stringify(batch)]);
    for(const row of batch)ctx.evaluator.onClosedCandle({...row,closeTime:row.time+step,valid:true}); // Indicator warmup only.
   }
   if(rows.length){ctx.watch.last_candle_time=String(rows.at(-1)!.time);await this.pool.query('UPDATE live_watches SET state_json=$2,last_candle_time=$3 WHERE run_id=$1 AND chain=$4 AND ca=$5',[ctx.run.id,JSON.stringify(ctx.evaluator.snapshot()),rows.at(-1)!.time,ctx.watch.chain,ctx.watch.ca]);}
  }
 }
 private async markRecovering(ctx:Context,reason:string){
  ctx.ready=false;ctx.watch.status='recovering';ctx.nextRecoveryAt=Date.now()+5_000;
  await this.pool.query("UPDATE live_watches SET status='recovering',recovery_reason=$4 WHERE run_id=$1 AND chain=$2 AND ca=$3",[ctx.run.id,ctx.watch.chain,ctx.watch.ca,reason]);
  await this.pool.query("UPDATE live_runs SET feed_state='recovering',feed_reason=$2 WHERE id=$1 AND status='running'",[ctx.run.id,reason]);
 }
 private async recover(ctx:Context){
  ctx.nextRecoveryAt=Date.now()+10_000;
  try{
   const pool=await this.lookup({chain:ctx.watch.chain as ProjectSignal['chain'],ca:ctx.watch.ca} as ProjectSignal);
   if(!pool)throw new Error('主池查询缺少可订阅交易池');
   if(pool.pairId!==ctx.watch.pair_id||pool.dexId!==ctx.watch.dex_id){
    this.aggregator.discardPair(ctx.watch.chain,ctx.watch.pair_id);
    const state=ctx.evaluator.snapshot();if(!state.position){state.history=[];state.lastCandleTime=undefined;ctx.watch.last_candle_time=null;}
    ctx.watch.pair_id=pool.pairId;ctx.watch.dex_id=pool.dexId;ctx.evaluator=new LiveEvaluator(ctx.run.strategy_json,Number(ctx.watch.signal_time),state);
    await this.pool.query('UPDATE live_watches SET pair_id=$4,dex_id=$5,last_candle_time=$6,state_json=$7 WHERE run_id=$1 AND chain=$2 AND ca=$3',[ctx.run.id,ctx.watch.chain,ctx.watch.ca,pool.pairId,pool.dexId,ctx.watch.last_candle_time,JSON.stringify(state)]);
    this.subscribe(ctx.watch);
    throw new Error('主池已切换，等待新交易池订阅确认');
   }
   await this.catchup(ctx);
   if(!ctx.evaluator.state.history.length)throw new Error('尚无可用历史行情，等待重试');
   ctx.noOrdersBefore=Date.now();
   if(![...this.watches.values()].some(other=>other!==ctx&&other.ready&&other.watch.chain===ctx.watch.chain&&other.watch.pair_id===ctx.watch.pair_id))
    this.aggregator.markClosedThrough(ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,ctx.noOrdersBefore);
   if(ctx.run.mode==='paper')await this.pool.query("UPDATE live_orders SET status='cancelled',updated_at=now() WHERE run_id=$1 AND chain=$2 AND ca=$3 AND status='pending'",[ctx.run.id,ctx.watch.chain,ctx.watch.ca]);
   ctx.ready=true;ctx.watch.status='monitoring';
   await this.pool.query("UPDATE live_watches SET status='monitoring',recovery_reason=NULL WHERE run_id=$1 AND chain=$2 AND ca=$3",[ctx.run.id,ctx.watch.chain,ctx.watch.ca]);
  }catch(e){await this.markRecovering(ctx,`补行情失败，稍后重试：${redact(e)}`);}
 }
 private async evictOrRetain(ctx:Context,reason:string){
  if(ctx.run.mode==='paper')await this.pool.query("UPDATE live_orders SET status='cancelled',updated_at=now() WHERE run_id=$1 AND chain=$2 AND ca=$3 AND side='buy' AND status='pending'",[ctx.run.id,ctx.watch.chain,ctx.watch.ca]);
  const held=!!ctx.evaluator.state.position,pending=await this.pending(ctx);
  const status=held||pending?'pending_eviction':'evicted_low_mcap';
  ctx.watch.status=status;
  await this.pool.query('UPDATE live_watches SET status=$4,recovery_reason=$5 WHERE run_id=$1 AND chain=$2 AND ca=$3',[ctx.run.id,ctx.watch.chain,ctx.watch.ca,status,reason]);
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
   const first=contexts[0]!;
   try{
    const project=await this.lookup({chain:first.watch.chain as ProjectSignal['chain'],ca:first.watch.ca} as ProjectSignal);
    if(project?.marketCap===undefined)continue; // Missing/failed data is not a low-cap verdict.
    for(const ctx of contexts){
     await this.pool.query('UPDATE live_watches SET current_mcap=$4,mcap_checked_at=now() WHERE run_id=$1 AND chain=$2 AND ca=$3',[ctx.run.id,ctx.watch.chain,ctx.watch.ca,project.marketCap]);
     if(project.marketCap<MIN_MARKET_CAP)await this.evictOrRetain(ctx,'MemeInfo 复查市值低于 50,000 USD');
    }
   }catch(e){console.error('MemeInfo 市值复查:',redact(e));}
   await wait(250);
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
 private async pending(ctx:Context){return !!(await this.pool.query("SELECT 1 FROM live_orders WHERE run_id=$1 AND chain=$2 AND ca=$3 AND status IN ('pending','submitted','unknown') LIMIT 1",[ctx.run.id,ctx.watch.chain,ctx.watch.ca])).rowCount;}
 private async createDecision(ctx:Context,d:LiveDecision){
  if(ctx.run.status!=='running'||!ctx.ready||ctx.run.execution_hold_reason)return;
  const key=createHash('sha256').update(`${ctx.run.id}:${ctx.watch.chain}:${ctx.watch.ca}:${d.side}:${d.reason}:${d.time}`).digest('hex');
  const cfg=ctx.run.strategy_json,position=ctx.evaluator.state.position;
  if(d.side==='buy'){
   if(ctx.watch.status==='pending_eviction'||!this.feedHealthy || d.time<=Number(ctx.watch.signal_time))return;
   const active=[...this.watches.values()].filter(x=>x.run.id===ctx.run.id&&x.evaluator.state.position).length;
   if(!position && active>=cfg.positionConfig.maxConcurrentPositions)return;
  }
  const available=Number(ctx.run.cash);
  const sizing=cfg.positionConfig.sizing;
  const amount=d.side==='sell'?ctx.run.mode==='live'?100:position?.quantity??0:
   ctx.run.mode==='live'?Number(ctx.run.risk_json?.maxOrderNative):
   sizing.type==='fixed_amount'?Math.min(sizing.value,available):available*sizing.value/100;
  if(!Number.isFinite(amount)||amount<=0)return;
  if(ctx.run.mode==='live' && (process.env.LIVE_TRADING_ENABLED!=='true'||!this.xxyy||ctx.run.chain==='robin'))return;
  const result=await this.pool.query(`INSERT INTO live_orders(run_id,chain,ca,pair_id,intent_key,side,reason,status,decision_time,decision_value,requested_amount,raw_result)
    VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11) ON CONFLICT(intent_key) DO NOTHING RETURNING id`,[ctx.run.id,ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,key,d.side,d.reason,d.time,d.value,amount,JSON.stringify({impulse:d.impulse??null})]);
  if(!result.rowCount)return;
  await this.pool.query("INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_key,event_time,payload) VALUES($1,$2,$3,$4,'decision',$5,$6,$7) ON CONFLICT(event_key) DO NOTHING",[ctx.run.id,ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,`decision:${key}`,d.time,JSON.stringify({side:d.side,reason:d.reason,value:d.value})]);
  if(ctx.run.mode==='live')await this.submitLive(ctx,result.rows[0].id,d,amount);
 }
 private async paperFill(ctx:Context,trade:MarketTrade){
  if(ctx.run.value_type==='mcap'&&(!trade.mcap||trade.mcap<=0))return;
  const orders=(await this.pool.query("SELECT * FROM live_orders WHERE run_id=$1 AND chain=$2 AND ca=$3 AND status='pending' AND decision_time<$4 ORDER BY created_at LIMIT 1",[ctx.run.id,trade.chain,trade.ca,trade.time])).rows;
  if(!orders.length)return;const o=orders[0],s=structuredClone(ctx.evaluator.state),cfg=ctx.run.strategy_json.executionConfig;
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
   else{const impulse=o.raw_result?.impulse??detectImpulseAtDecision(ctx,o.decision_time);if(!impulse)throw new Error('模拟订单缺少可核验拉升依据');s.position={entryPrice:value,quantity,entries:1,entryTime:trade.time,entryBar:s.history.length-1,impulse,tradeNo:s.trades+1,costBasisUsd:gross+fee+slip+tax};}
  }else{
   if(!s.position)return;quantity=Math.min(s.position.quantity,Number(o.requested_amount));gross=quantity*trade.price;
   fee=gross*feeRate;slip=gross*slipRate;tax=gross*taxRate;newCash=Number(ctx.run.cash)+gross-fee-slip-tax;
   const basis=(s.position.costBasisUsd??0)*(quantity/s.position.quantity);newPnl+=gross-fee-slip-tax-basis;
   s.position.quantity-=quantity;s.position.costBasisUsd=(s.position.costBasisUsd??0)-basis;
   if(s.position.quantity<=1e-12){s.position=undefined;s.trades++;s.lastEntryMatch=true;}
  }
  const c=await this.pool.connect();try{await c.query('BEGIN');
   const fillValue=ctx.run.value_type==='price'?trade.price:trade.mcap!;
   await c.query("INSERT INTO live_fills(order_id,fill_time,fill_price,fill_value,quantity,gross_amount,fee,slippage_cost,tax_cost) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",[o.id,trade.time,trade.price,fillValue,quantity,gross,fee,slip,tax]);
   await c.query("UPDATE live_orders SET status='filled',updated_at=now() WHERE id=$1 AND status='pending'",[o.id]);
   await c.query('UPDATE live_runs SET cash=$2,realized_pnl=$3,updated_at=now() WHERE id=$1',[ctx.run.id,newCash,newPnl]);
   await c.query('UPDATE live_watches SET state_json=$2 WHERE run_id=$1 AND chain=$3 AND ca=$4',[ctx.run.id,JSON.stringify(s),ctx.watch.chain,ctx.watch.ca]);
   await c.query("INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_key,event_time,payload) VALUES($1,$2,$3,$4,'fill',$5,$6,$7) ON CONFLICT(event_key) DO NOTHING",[ctx.run.id,ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,`fill:${o.id}`,trade.time,JSON.stringify({side:o.side,reason:o.reason,price:trade.price,value:fillValue,quantity})]);
   await c.query('COMMIT');Object.assign(ctx.evaluator.state,s);ctx.run.cash=String(newCash);ctx.run.realized_pnl=String(newPnl);
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  if(o.side==='sell'&&ctx.watch.status==='pending_eviction')await this.evictOrRetain(ctx,'低市值持仓已平仓');
 }
 private async submitLive(ctx:Context,orderId:string,d:LiveDecision,amount:number){
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
