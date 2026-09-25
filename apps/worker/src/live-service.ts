import {createHash} from 'node:crypto';
import {io,type Socket} from 'socket.io-client';
import WebSocket from 'ws';
import type {Pool,PoolClient} from 'pg';
import {LiveCandleAggregator,LiveEvaluator,detectImpulse,type ClosedMarketBar,type LiveDecision,type MarketTrade} from '@meme/engine';
import type {Candle,StrategyConfig} from '@meme/domain';
import {parseMarketTrade,parseProjectSignal,type ProjectSignal} from './live-input.js';

type Run={id:string;mode:'paper'|'live';chain:string;signal_source:string;interval:'30s'|'1m';value_type:'price'|'mcap';status:string;strategy_json:StrategyConfig;cash:string;realized_pnl:string;wallet_address:string|null;risk_json:any;started_at:Date};
type Watch={run_id:string;chain:string;ca:string;pair_id:string;signal_time:string;state_json:any;last_candle_time:string|null};
type Context={run:Run;watch:Watch;evaluator:LiveEvaluator;ready:boolean};
const watchKey=(r:string,c:string,a:string)=>`${r}:${c}:${a}`;
const pairKey=(c:string,p:string)=>`${c}:${p.toLowerCase()}`;
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
 private readonly lastMarketTime=new Map<string,number>();
 private signal?:WebSocket;private lock?:PoolClient;private refreshTimer?:ReturnType<typeof setInterval>;private flushTimer?:ReturnType<typeof setInterval>;
 private chain=Promise.resolve();private stopped=false;private feedHealthy=false;
 private readonly xxyy=process.env.XXYY_API_KEY?new XxyyTradeClient(process.env.XXYY_API_KEY):undefined;
 constructor(private readonly pool:Pool){}
 private enqueue(fn:()=>Promise<void>){this.chain=this.chain.then(fn).catch(e=>console.error('live service:',redact(e)));}
 async start(){
  if(!process.env.MEMEINFO_SIGNAL_TOKEN||!process.env.XXYY_TRADE_CHANNEL_TEMPLATE||!process.env.XXYY_TRADE_EVENT){console.log('live service disabled: signal or trade feed configuration missing');return;}
  const client=await this.pool.connect();
  const locked=(await client.query('SELECT pg_try_advisory_lock(63920924) AS acquired')).rows[0]?.acquired;
  if(!locked){client.release();console.log('live service standby: another owner holds advisory lock');return;}
  this.lock=client;
  await this.refresh();this.connectSignals();
  this.refreshTimer=setInterval(()=>this.enqueue(()=>this.refresh()),5_000);
  this.flushTimer=setInterval(()=>this.aggregator.flush(Date.now()),1_000);
  console.log('live service started; real orders',process.env.LIVE_TRADING_ENABLED==='true'?'armed by server configuration':'disabled');
 }
 async close(){this.stopped=true;if(this.refreshTimer)clearInterval(this.refreshTimer);if(this.flushTimer)clearInterval(this.flushTimer);this.signal?.close();for(const socket of this.sockets.values())socket.disconnect();await this.chain;if(this.lock){await this.lock.query('SELECT pg_advisory_unlock(63920924)');this.lock.release();}}
 private async refresh(){
  if(this.stopped)return;
  const rows=(await this.pool.query("SELECT * FROM live_runs WHERE status='running'")).rows as Run[];
  const active=new Set(rows.map(r=>r.id));
  const watchRows=(await this.pool.query("SELECT w.* FROM live_watches w JOIN live_runs r ON r.id=w.run_id WHERE r.status='running' AND w.status='monitoring'")).rows as Watch[];
  const runMap=new Map(rows.map(r=>[r.id,r]));
  for(const w of watchRows){const key=watchKey(w.run_id,w.chain,w.ca);const old=this.watches.get(key);if(old){old.run=runMap.get(w.run_id)!;continue;}
   const run=runMap.get(w.run_id);if(!run)continue;
   const ctx={run,watch:w,evaluator:new LiveEvaluator(run.strategy_json,Number(w.signal_time),w.state_json?.history?w.state_json:undefined),ready:!!w.state_json?.history};
   this.watches.set(key,ctx);
   if(w.last_candle_time)await this.catchup(ctx);
  }
  for(const [key,ctx] of this.watches)if(!active.has(ctx.run.id)||!watchRows.some(w=>watchKey(w.run_id,w.chain,w.ca)===key))this.watches.delete(key);
  const required=new Map([...this.watches.values()].map(ctx=>[pairKey(ctx.watch.chain,ctx.watch.pair_id),ctx.watch]));
  for(const [key,watch] of required)if(!this.sockets.has(key))this.subscribe(watch);
  for(const [key,socket] of this.sockets)if(!required.has(key)){socket.disconnect();this.sockets.delete(key);const [chain,pairId]=key.split(':');this.aggregator.discardPair(chain,pairId);this.lastMarketTime.delete(key);}
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
  return typeof item?.main_pair_id==='string'&&item.main_pair_id?item.main_pair_id as string:undefined;
 }
 private async onSignal(signal:ProjectSignal){
  if(!this.feedHealthy||signal.time>Date.now()+5_000)return;
  const runs=(await this.pool.query("SELECT id,signal_source,started_at FROM live_runs WHERE status='running' AND chain=$1 AND started_at IS NOT NULL AND signal_source IN ('all',$2)",[signal.chain,signal.source])).rows;
  const relevant=runs.filter(r=>acceptsNewSignal(r,signal));
  if(!relevant.length)return;
  const pairId=await this.lookup(signal);
  if(!pairId){await this.pool.query("INSERT INTO live_events(chain,ca,kind,event_time,payload) VALUES($1,$2,'lookup_unmatched',$3,$4)",[signal.chain,signal.ca,signal.time,JSON.stringify({source:signal.source})]);return;}
  const c=await this.pool.connect();
  try{await c.query('BEGIN');
   await c.query(`INSERT INTO token_signal_events(chain,ca,signal_source,detail_id,signal_time,source_signal,provenance)
    VALUES($1,$2,$3,$4,$5,$6,'[]') ON CONFLICT(chain,ca,signal_source,detail_id) DO NOTHING`,[signal.chain,signal.ca,signal.source,signal.key,signal.time,JSON.stringify(signal.identity)]);
   await c.query(`INSERT INTO token_info(chain,ca,pair,signal_source,source_signal,signal_time) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(chain,ca,pair) DO UPDATE SET signal_source=CASE WHEN token_info.signal_time IS NULL OR EXCLUDED.signal_time<token_info.signal_time THEN EXCLUDED.signal_source ELSE token_info.signal_source END,
    source_signal=CASE WHEN token_info.signal_time IS NULL OR EXCLUDED.signal_time<token_info.signal_time THEN EXCLUDED.source_signal ELSE token_info.source_signal END,
    signal_time=LEAST(COALESCE(token_info.signal_time,EXCLUDED.signal_time),EXCLUDED.signal_time)`,[signal.chain,signal.ca,pairId,signal.source,JSON.stringify(signal.identity),signal.time]);
   for(const r of relevant){
    await c.query(`INSERT INTO live_watches(run_id,chain,ca,pair_id,signal_source,signal_key,signal_time)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING run_id`,[r.id,signal.chain,signal.ca,pairId,signal.source,signal.key,signal.time]);
    await c.query("INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_key,event_time,payload) VALUES($1,$2,$3,$4,'external_signal',$5,$6,$7) ON CONFLICT(event_key) DO NOTHING",[r.id,signal.chain,signal.ca,pairId,`${r.id}:${signal.key}`,signal.time,JSON.stringify(signal.identity)]);
   }
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  await this.refresh();
 }
 private subscribe(watch:Watch){
  const template=process.env.XXYY_TRADE_CHANNEL_TEMPLATE!;
  if(!template.includes('{pairId}'))throw new Error('XXYY_TRADE_CHANNEL_TEMPLATE 必须包含 {pairId}');
  const channel=template.replaceAll('{pairId}',watch.pair_id).replaceAll('{chain}',watch.chain),event=process.env.XXYY_TRADE_EVENT!;
  const socket=io(process.env.XXYY_PUSH_URL??'wss://web-push.xxyy.io/data',{transports:['websocket'],forceNew:true,reconnection:true});
  const key=pairKey(watch.chain,watch.pair_id);this.sockets.set(key,socket);
  socket.on('connect',()=>socket.emit('SUBSCRIBE',channel,{}));
  socket.on('disconnect',()=>this.enqueue(()=>this.feedInterrupted(watch.chain,watch.pair_id)));
  socket.on(event,raw=>{const trade=parseMarketTrade(raw,{chain:watch.chain,ca:watch.ca,pairId:watch.pair_id});if(trade)this.enqueue(()=>this.onTrade(trade));});
  socket.on('connect_error',error=>console.error('XXYY trade connection:',redact(error)));
 }
 private async feedInterrupted(chain:string,pairId:string){
  this.aggregator.discardPair(chain,pairId);
  const contexts=[...this.watches.values()].filter(c=>c.watch.chain===chain&&c.watch.pair_id===pairId);
  for(const ctx of contexts)await this.needsAttention(ctx,'实时成交源中断或成交时间回退；需要补行情与仓位核对后手动恢复');
  await this.refresh();
 }
 private async onTrade(trade:MarketTrade){
  if(this.stopped || trade.time>Date.now()+5_000)return;
  const market=pairKey(trade.chain,trade.pairId),previous=this.lastMarketTime.get(market);
  if(previous!==undefined&&trade.time<previous){await this.feedInterrupted(trade.chain,trade.pairId);return;}
  if(!this.aggregator.accept(trade))return;
  this.lastMarketTime.set(market,trade.time);
  const contexts=[...this.watches.values()].filter(c=>c.watch.chain===trade.chain&&c.watch.pair_id===trade.pairId&&c.run.status==='running');
  for(const ctx of contexts){
   if(ctx.run.value_type==='mcap'&&(!trade.mcap||trade.mcap<=0)){await this.needsAttention(ctx,'实时成交缺少可靠市值，市值策略暂停入场和退出');continue;}
   ctx.evaluator.state.lastTokenPrice=trade.price;
   if(ctx.run.mode==='paper')await this.paperFill(ctx,trade);
   const decision=ctx.evaluator.onTrade(trade,ctx.run.value_type);
   if(decision && !await this.pending(ctx))await this.createDecision(ctx,decision);
  }
 }
 private async onBar(bar:ClosedMarketBar){
  const c=bar.candle;
  await this.pool.query(`INSERT INTO meme_kline(chain,ca,pair_id,interval,open_time,close_time,open,high,low,close,volume,trade_count,type,source,raw_data,valid)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'xxyy_socket',$14,true)
    ON CONFLICT(chain,pair_id,interval,open_time,type) DO UPDATE SET ca=EXCLUDED.ca,close_time=EXCLUDED.close_time,open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,volume=EXCLUDED.volume,trade_count=EXCLUDED.trade_count,source=EXCLUDED.source,raw_data=EXCLUDED.raw_data,valid=true,invalid_reason=NULL`,
    [bar.symbol.chain,bar.symbol.ca,bar.symbol.pairId,bar.interval,c.time,c.closeTime,c.open,c.high,c.low,c.close,c.volume,bar.tradeCount,bar.type,JSON.stringify({feed:'xxyy_socket',closed:true})]);
  const contexts=[...this.watches.values()].filter(ctx=>ctx.run.status==='running'&&ctx.watch.chain===bar.symbol.chain&&ctx.watch.pair_id===bar.symbol.pairId&&ctx.run.interval===bar.interval&&ctx.run.value_type===bar.type);
  for(const ctx of contexts){
   if(!ctx.ready)await this.warmup(ctx,c.time);
   const decision=ctx.evaluator.onClosedCandle(c);
   if(decision && !await this.pending(ctx))await this.createDecision(ctx,decision);
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
 private async warmup(ctx:Context,before:number){
  const rows=(await this.pool.query(`SELECT * FROM (SELECT open_time,close_time,open,high,low,close,volume FROM meme_kline
    WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND valid IS DISTINCT FROM false AND open_time<$6 ORDER BY open_time DESC LIMIT 600) x ORDER BY open_time`,
    [ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,ctx.run.interval,ctx.run.value_type,before])).rows;
  for(const r of rows){const c:Candle={time:Number(r.open_time),closeTime:Number(r.close_time),open:Number(r.open),high:Number(r.high),low:Number(r.low),close:Number(r.close),volume:Number(r.volume)};ctx.evaluator.onClosedCandle(c);}
  ctx.ready=true;
 }
 private async catchup(ctx:Context){
  const step=ctx.run.interval==='30s'?30_000:60_000,from=Number(ctx.watch.last_candle_time)+step,to=Math.floor(Date.now()/step)*step;
  if(from>=to)return;
  if((to-from)/step>5000){await this.needsAttention(ctx,'行情断档超过 5000 根，禁止自动恢复');return;}
  if(ctx.evaluator.state.position){await this.needsAttention(ctx,'断线期间存在持仓，需要先核对实际退出与仓位');return;}
  const response=await fetch('https://www.xxyy.io/api/data/candlestick/searchBarData',{method:'POST',headers:{'X-CHAIN':ctx.watch.chain,'X-VERSION':'1','X-LANGUAGE':'zh','Content-Type':'application/json'},body:JSON.stringify({pairId:ctx.watch.pair_id,valueType:ctx.run.value_type==='mcap'?'mc':'price',interval:step/1000,priceType:'usd',from,to,countBack:5000}),signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw new Error(`XXYY 历史补数 HTTP ${response.status}`);
  const data=await response.json() as any;if(data.code!==0||!Array.isArray(data.data))throw new Error('XXYY 历史补数响应无效');
  const rows=data.data.map((row:any)=>({time:Number(row.time),open:Number(row.price?.open),high:Number(row.price?.high),low:Number(row.price?.low),close:Number(row.price?.close),volume:Number(row.price?.volume)}))
   .filter((row:Candle)=>Number.isSafeInteger(row.time)&&row.time>=from&&row.time+step<=to&&row.time%step===0&&row.low>0&&row.high>=Math.max(row.open,row.close)&&row.low<=Math.min(row.open,row.close)&&row.volume>=0)
   .sort((a:Candle,b:Candle)=>a.time-b.time);
  for(const row of rows){
   const candle={...row,closeTime:row.time+step,valid:true};
   await this.pool.query(`INSERT INTO meme_kline(chain,ca,pair_id,interval,open_time,close_time,open,high,low,close,volume,trade_count,type,source,raw_data,valid)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,'xxyy',null,true)
    ON CONFLICT(chain,pair_id,interval,open_time,type) DO NOTHING`,[ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,ctx.run.interval,candle.time,candle.closeTime,candle.open,candle.high,candle.low,candle.close,candle.volume,ctx.run.value_type]);
   ctx.evaluator.onClosedCandle(candle); // Rebuild indicators only: never place retroactive orders.
  }
  if(rows.length){ctx.ready=true;await this.pool.query('UPDATE live_watches SET state_json=$2,last_candle_time=$3 WHERE run_id=$1 AND chain=$4 AND ca=$5',[ctx.run.id,JSON.stringify(ctx.evaluator.snapshot()),rows.at(-1)!.time,ctx.watch.chain,ctx.watch.ca]);}
 }
 private async needsAttention(ctx:Context,reason:string){
  ctx.run.status='attention';
  await this.pool.query("UPDATE live_runs SET status='attention',error_message=$2,updated_at=now() WHERE id=$1 AND status='running'",[ctx.run.id,reason]);
  await this.pool.query("INSERT INTO live_events(run_id,chain,ca,pair_id,kind,event_time,payload) VALUES($1,$2,$3,$4,'attention',$5,$6)",[ctx.run.id,ctx.watch.chain,ctx.watch.ca,ctx.watch.pair_id,Date.now(),JSON.stringify({reason})]);
 }
 private async pending(ctx:Context){return !!(await this.pool.query("SELECT 1 FROM live_orders WHERE run_id=$1 AND chain=$2 AND ca=$3 AND status IN ('pending','submitted','unknown') LIMIT 1",[ctx.run.id,ctx.watch.chain,ctx.watch.ca])).rowCount;}
 private async createDecision(ctx:Context,d:LiveDecision){
  if(ctx.run.status!=='running')return;
  const key=createHash('sha256').update(`${ctx.run.id}:${ctx.watch.chain}:${ctx.watch.ca}:${d.side}:${d.reason}:${d.time}`).digest('hex');
  const cfg=ctx.run.strategy_json,position=ctx.evaluator.state.position;
  if(d.side==='buy'){
   if(!this.feedHealthy || d.time<=Number(ctx.watch.signal_time))return;
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
   await this.needsAttention(ctx,`实盘下单前核验失败：${redact(e)}`);
   return;
  }
  try{
   const txId=await this.xxyy!.swap({chain:ctx.run.chain as 'sol'|'bsc',walletAddress:ctx.run.wallet_address!,tokenAddress:ctx.watch.ca,isBuy:d.side==='buy',amount,tip:risk.tip,slippage:risk.slippagePercent});
   await this.pool.query("UPDATE live_orders SET status='submitted',tx_id=$2,updated_at=now() WHERE id=$1",[orderId,txId]);
   // The API's response has native-token amounts but not a verified USD fill or fees.
   // Until reconciliation is implemented, do not infer a position or send another order.
   await this.pool.query("UPDATE live_runs SET status='attention',error_message='链上订单已提交；等待核对钱包实际持仓和成交成本后继续',updated_at=now() WHERE id=$1",[ctx.run.id]);
  }catch(e){
   await this.pool.query("UPDATE live_orders SET status='unknown',updated_at=now() WHERE id=$1",[orderId]);
   await this.pool.query("UPDATE live_runs SET status='attention',error_message='XXYY 下单结果未知，禁止重试；请核对钱包和链上记录',updated_at=now() WHERE id=$1",[ctx.run.id]);
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
