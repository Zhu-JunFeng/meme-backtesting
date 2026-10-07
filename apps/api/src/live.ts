import {BadRequestException,ConflictException,Controller,Get,Headers,Param,Post,Body,Query,Req} from '@nestjs/common';
import {scryptSync,timingSafeEqual} from 'node:crypto';
import {Pool} from 'pg';
import type {StrategyConfig} from '@meme/domain';
import {buildLivePortfolio} from './live-portfolio.js';
import {liveFib,decisionBucket} from './live-locator.js';

type Mode='paper'|'live';
type Risk={maxOrderNative:number;maxTotalNative:number;maxDailyLossUsd:number;maxPositions:number;tip:number;slippagePercent:number};
export type LiveSignalSource='all'|'top_cluster_first_buy'|'fomo_new_project_expanded';
type RequestBody={name:string;mode:Mode;chain:'sol'|'bsc'|'robin';interval:'30s'|'1m';valueType:'price'|'mcap';strategyVersionId:string;initialCapital:number;signalSource?:LiveSignalSource;clientKey?:string;walletAddress?:string;risk?:Risk};
export const validLiveSignalSource=(value:unknown):value is LiveSignalSource=>['all','top_cluster_first_buy','fomo_new_project_expanded'].includes(String(value));
const positive=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>0;
const mask=(wallet:string|null)=>wallet?`${wallet.slice(0,5)}…${wallet.slice(-4)}`:null;
const publicRow=(r:any)=>({...r,wallet_address:mask(r.wallet_address),risk_json:r.mode==='live'?undefined:r.risk_json});

/** The browser keeps the password in memory only. In production it is accepted only behind HTTPS. */
export function requireLiveAdmin(password:string|undefined,request:any){
 const setting=process.env.LIVE_ADMIN_PASSWORD_HASH;
 if(!setting)throw new ConflictException('未配置实盘管理员口令');
 if(process.env.NODE_ENV==='production'){
  const origin=String(request.socket?.remoteAddress??'');
  if(request.headers['x-forwarded-proto']!=='https'||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(origin))throw new ConflictException('实盘管理必须经本机 HTTPS 反向代理访问');
 }
 const [salt,expected]=setting.split(':');
 if(!salt || !/^[0-9a-f]{128}$/i.test(expected??''))throw new ConflictException('实盘管理员口令配置无效');
 const actual=scryptSync(password??'',salt,64),target=Buffer.from(expected,'hex');
 if(!timingSafeEqual(actual,target))throw new ConflictException('管理员口令错误');
}
export function validateRisk(risk:Risk|undefined){
 if(!risk || !positive(risk.maxOrderNative)||!positive(risk.maxTotalNative)||risk.maxOrderNative>risk.maxTotalNative||!positive(risk.maxDailyLossUsd)||!Number.isInteger(risk.maxPositions)||risk.maxPositions<1||risk.maxPositions>100||!positive(risk.tip)||!positive(risk.slippagePercent)||risk.slippagePercent>100)throw new BadRequestException('实盘必须填写有效的单笔金额、总敞口、日亏损、最大持仓数、优先费和滑点上限');
}

@Controller('api')
export class LiveController {
 private readonly pool=new Pool({connectionString:process.env.DATABASE_URL??'postgresql://postgres@localhost:5432/backtesting'});
 async onModuleDestroy(){await this.pool.end();}
 @Post('live-admin/check') check(@Headers('x-live-admin-password') password:string,@Req() request:any){requireLiveAdmin(password,request);return {ok:true};}
 @Get('live-runs') async list(@Query('mode') mode?:string){
  if(mode && !['paper','live'].includes(mode))throw new BadRequestException('模式无效');
  const rows=(await this.pool.query(`SELECT r.id,r.name,r.mode,r.chain,r.interval,r.value_type,r.signal_source,r.strategy_version_id,r.initial_capital,r.wallet_address,r.risk_json,r.status,r.cash,r.realized_pnl,r.started_at,r.heartbeat_at,r.error_message,r.feed_state,r.feed_reason,r.execution_hold_reason,r.reconnect_count,r.late_trade_count,r.dropped_trade_count,r.last_signal_at,r.last_trade_at,r.created_at,r.updated_at,
   r.execution_version,r.execution_switched_at,r.market_source,r.market_switched_at,r.market_status,
   (SELECT COUNT(*)::int FROM live_watches w WHERE w.run_id=r.id AND w.status IN ('monitoring','recovering','pending_eviction')) AS active_ca_count
   FROM live_runs r WHERE ($1::text IS NULL OR r.mode=$1) ORDER BY r.created_at DESC LIMIT 300`,[mode??null])).rows;
  return rows.map(publicRow);
 }
 @Post('live-runs') async create(@Body() body:RequestBody,@Headers('x-live-admin-password') password:string,@Req() request:any){
  if(!body || !body.name?.trim() || !['paper','live'].includes(body.mode) || !['sol','bsc','robin'].includes(body.chain) || !['30s','1m'].includes(body.interval)||!['price','mcap'].includes(body.valueType)||!positive(body.initialCapital))throw new BadRequestException('实时任务配置无效');
  if(!validLiveSignalSource(body.signalSource??'all'))throw new BadRequestException('信号来源无效');
  if(body.clientKey!==undefined && (body.mode!=='paper'||typeof body.clientKey!=='string'||!(/^[a-z0-9][a-z0-9:_-]{7,127}$/).test(body.clientKey)))throw new BadRequestException('模拟盘幂等键无效');
  if(body.mode==='live'){
   requireLiveAdmin(password,request);validateRisk(body.risk);
   if(body.chain==='robin')throw new BadRequestException('ROBIN 实盘接口尚未核验，只能使用模拟盘');
   if(!body.walletAddress?.trim())throw new BadRequestException('实盘必须绑定专用 XXYY 钱包');
   if(body.chain==='sol'&&!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(body.walletAddress.trim()))throw new BadRequestException('SOL 钱包地址格式无效');
   if(body.chain==='bsc'&&!/^0x[0-9a-fA-F]{40}$/.test(body.walletAddress.trim()))throw new BadRequestException('BSC 钱包地址格式无效');
   if(body.chain==='sol'&&(body.risk!.tip<0.001||body.risk!.tip>0.1))throw new BadRequestException('SOL 优先费必须为 0.001–0.1 SOL');
   if(body.chain==='bsc'&&(body.risk!.tip<0.1||body.risk!.tip>100))throw new BadRequestException('BSC 优先费必须为 0.1–100 Gwei');
  }
  const version=(await this.pool.query('SELECT strategy_json FROM backtest_strategy_versions WHERE id=$1',[body.strategyVersionId])).rows[0];
  if(!version)throw new BadRequestException('策略版本不存在');
  const strategy=structuredClone(version.strategy_json) as StrategyConfig;
  if(strategy.entryAfterSignal===false)throw new BadRequestException('实时任务只能使用仅在信号触发后买入的策略');
  strategy.entryAfterSignal=true;
  if(body.mode==='live' && strategy.positionConfig.maxConcurrentPositions>body.risk!.maxPositions)throw new BadRequestException('实盘硬性最大持仓数不能小于策略最大持仓数');
  let result;
  try{result=await this.pool.query(`INSERT INTO live_runs(name,mode,chain,interval,value_type,signal_source,client_key,strategy_version_id,strategy_json,initial_capital,wallet_address,risk_json,cash)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$10) ON CONFLICT (client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING *`,[body.name.trim(),body.mode,body.chain,body.interval,body.valueType,body.signalSource??'all',body.clientKey??null,body.strategyVersionId,JSON.stringify(strategy),body.initialCapital,body.mode==='live'?body.walletAddress!.trim():null,body.mode==='live'?JSON.stringify(body.risk):null]);}
  catch(error:any){if(error?.code==='23505')throw new ConflictException('该链钱包已绑定其他实盘任务，必须使用独立钱包');throw error;}
  if(!result.rowCount){
   const existing=(await this.pool.query('SELECT * FROM live_runs WHERE client_key=$1',[body.clientKey])).rows[0];
   if(!existing||existing.mode!==body.mode||existing.chain!==body.chain||existing.interval!==body.interval||existing.value_type!==body.valueType||existing.signal_source!==(body.signalSource??'all')||existing.strategy_version_id!==body.strategyVersionId||Number(existing.initial_capital)!==body.initialCapital)throw new ConflictException('幂等键已用于不同配置');
   return publicRow(existing);
  }
  return publicRow(result.rows[0]);
 }
 @Post('live-runs/emergency-stop') async emergency(@Headers('x-live-admin-password') password:string,@Req() request:any){
  requireLiveAdmin(password,request);
  const result=await this.pool.query("UPDATE live_runs SET status='paused',feed_state='paused',updated_at=now(),error_message='管理员紧急停止：不再产生新订单' WHERE mode='live' AND status='running' RETURNING id");
  return {stopped:result.rows.map(r=>r.id)};
 }
 @Get('live-runs/:id') async one(@Param('id') id:string){
  const result=await this.pool.query('SELECT * FROM live_runs WHERE id=$1',[id]);
  if(!result.rowCount)throw new BadRequestException('实时任务不存在');
  const [watches,orders,events]=await Promise.all([
   this.pool.query('SELECT chain,ca,pair_id,signal_source,signal_time,status,last_candle_time,last_trade_at,current_mcap,recovery_reason,state_json FROM live_watches WHERE run_id=$1 ORDER BY created_at DESC LIMIT 500',[id]),
   this.pool.query('SELECT o.*,f.fill_time,f.fill_price,f.quantity,f.gross_amount,f.fee,f.slippage_cost,f.tax_cost FROM live_orders o LEFT JOIN live_fills f ON f.order_id=o.id WHERE o.run_id=$1 ORDER BY o.created_at DESC LIMIT 500',[id]),
   this.pool.query('SELECT kind,chain,ca,pair_id,event_time,payload FROM live_events WHERE run_id=$1 ORDER BY event_time DESC LIMIT 200',[id])]);
  const run=result.rows[0],activeCaCount=watches.rows.filter(w=>['monitoring','recovering','pending_eviction'].includes(w.status)).length;
  return {run:publicRow({...run,active_ca_count:activeCaCount,active_ca_limit:20}),watches:watches.rows.map(r=>({...r,state_json:{position:r.state_json?.position??null}})),orders:orders.rows.map(r=>({...r,raw_result:undefined})),events:events.rows};
 }
 @Get('live-runs/:id/portfolio') async portfolio(@Param('id') id:string,@Query() q:Record<string,string>){
  const tab=q.tab??'current';if(!['current','history','signals'].includes(tab))throw new BadRequestException('持仓视图无效');
  const page=Number(q.page??1),pageSize=Number(q.pageSize??20);
  if(!Number.isInteger(page)||page<1||!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new BadRequestException('分页参数无效');
  const run=(await this.pool.query('SELECT id,mode,interval,value_type,strategy_json,realized_pnl FROM live_runs WHERE id=$1',[id])).rows[0];
  if(!run)throw new BadRequestException('实时任务不存在');
  const [fills,watches,signalCounts,unverified]=await Promise.all([
   this.pool.query(`SELECT o.id,o.position_id,o.chain,o.ca,o.pair_id,o.side,o.reason,o.decision_time,f.fill_time,f.fill_value,f.fill_price,f.market_cap,f.quantity,f.gross_amount,f.fee,f.slippage_cost,f.tax_cost
    FROM live_orders o JOIN live_fills f ON f.order_id=o.id WHERE o.run_id=$1 AND o.status='filled' ORDER BY f.fill_time,o.decision_time,o.id`,[id]),
   this.pool.query('SELECT chain,ca,last_trade_at,state_json FROM live_watches WHERE run_id=$1',[id]),
   this.pool.query("SELECT COUNT(*) FILTER(WHERE side='buy')::int AS buys,COUNT(*) FILTER(WHERE side='sell')::int AS sells FROM live_orders WHERE run_id=$1",[id]),
   this.pool.query("SELECT COUNT(*)::int AS count FROM live_orders WHERE run_id=$1 AND status IN ('pending','submitted','unknown')",[id])
  ]);
  const asOf=Date.now();
  const portfolio=buildLivePortfolio(fills.rows,watches.rows,run.strategy_json,run.value_type,run.interval,asOf);
  const summary={...portfolio.summary,buySignalCount:signalCounts.rows[0].buys,sellSignalCount:signalCounts.rows[0].sells,unverifiedOrderCount:unverified.rows[0].count,accountRealizedPnl:Number(run.realized_pnl)};
  if(tab==='signals'){
   const [rows,total]=await Promise.all([
    this.pool.query('SELECT id,chain,ca,pair_id,side,reason,status,decision_time,decision_value,created_at FROM live_orders WHERE run_id=$1 ORDER BY decision_time DESC,id DESC LIMIT $2 OFFSET $3',[id,pageSize,(page-1)*pageSize]),
    this.pool.query('SELECT COUNT(*)::int AS count FROM live_orders WHERE run_id=$1',[id])
   ]);
   return {items:rows.rows,total:total.rows[0].count,page,pageSize,summary,valueType:run.value_type,asOf};
  }
  const rows=tab==='current'?portfolio.open:portfolio.closed;
  return {items:rows.slice((page-1)*pageSize,page*pageSize),total:rows.length,page,pageSize,summary,valueType:run.value_type,asOf};
 }
 @Get('live-runs/:id/locate') async locate(@Param('id') id:string,@Query() q:Record<string,string>){
  if((!!q.positionId)===(!!q.orderId))throw new BadRequestException('请选择一笔持仓或一条信号');
  const run=(await this.pool.query('SELECT id,interval,value_type,strategy_json FROM live_runs WHERE id=$1',[id])).rows[0];
  if(!run)throw new BadRequestException('任务不存在');
  const orders=(await this.pool.query(`SELECT o.id,o.position_id,o.chain,o.ca,o.pair_id,o.side,o.reason,o.status,o.decision_time,o.decision_value,o.raw_result,
    f.fill_time,f.fill_value,f.fill_price,f.market_cap,f.quantity,f.gross_amount,f.fee,f.slippage_cost,f.tax_cost FROM live_orders o LEFT JOIN live_fills f ON f.order_id=o.id WHERE o.run_id=$1 ORDER BY o.decision_time,o.id`,[id])).rows;
  const selected=q.orderId?orders.find(o=>o.id===q.orderId):undefined;
  if(q.orderId&&!selected)throw new BadRequestException('信号不存在');
  const filled=orders.filter(o=>o.status==='filled'&&o.fill_time!=null);
  const watches=(await this.pool.query('SELECT chain,ca,last_trade_at,state_json FROM live_watches WHERE run_id=$1',[id])).rows;
  const portfolio=buildLivePortfolio(filled,watches,run.strategy_json,run.value_type,run.interval);
  const cycle=q.positionId?portfolio.cycles.find(c=>c.id===q.positionId):
   selected?.status==='filled'?portfolio.cycles.find(c=>c.orderIds.includes(selected.id)):undefined;
  if(q.positionId&&!cycle)throw new BadRequestException('持仓不存在或成交关联不完整');
  const related=cycle?filled.filter(o=>cycle.orderIds.includes(o.id)):[];
  const pairIds=cycle?.pairIds??[selected!.pair_id];
  const pairId=q.pairId??(cycle?.pairId??selected!.pair_id);
  if(!pairIds.includes(pairId))throw new BadRequestException('交易池不属于所选持仓');
  const first=related.find(o=>o.side==='buy');
  const event=cycle?first!:selected!;
  const pairEvents=related.filter(o=>o.pair_id===pairId);
  const start=cycle?Number(pairEvents[0]?.fill_time??first!.fill_time):decisionBucket(Number(selected!.decision_time),selected!.reason,run.interval==='30s'?30_000:60_000);
  const end=cycle?(cycle.sellTime==null?Date.now():Number(pairEvents.at(-1)?.fill_time??cycle.sellTime)):start;
  const impulse=first?.raw_result?.impulse;
  const buys=related.filter(o=>o.side==='buy').map((o,index)=>({...o,label:index===0?`买${cycle!.tradeNo}`:`加${cycle!.tradeNo}.${index}`}));
  const fib=cycle?(pairId===first!.pair_id?liveFib(run.strategy_json,impulse,Number(first!.decision_time),cycle.sellTime,buys):{status:'unavailable',reason:'Fib 锚点属于首次入场交易池；当前池只显示自身 K 线和成交事件'}):null;
  const fibStart=fib?.status==='available'&&'low' in fib?Math.min(start,Number(fib.low.time)):start;
  const boundsFor=async(begin:number)=>this.pool.query(`SELECT
    (SELECT min(open_time) FROM (SELECT open_time FROM public.meme_kline WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND valid IS DISTINCT FROM false AND open_time<=$6 ORDER BY open_time DESC LIMIT 100) b) AS before,
    (SELECT max(open_time) FROM (SELECT open_time FROM public.meme_kline WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND valid IS DISTINCT FROM false AND open_time>=$7 ORDER BY open_time LIMIT 100) a) AS after`,[event.chain,event.ca,pairId,run.interval,run.value_type,begin,end]);
  const [bounds,fibBounds]=await Promise.all([boundsFor(start),fibStart===start?Promise.resolve(null):boundsFor(fibStart)]);
  const step=run.interval==='30s'?30_000:60_000;
  const from=Number(bounds.rows[0].before??Math.max(0,start-step*100)),to=Number(bounds.rows[0].after??end);
  const fibFrom=Number(fibBounds?.rows[0].before??from);
  return {symbol:`${event.chain}:${event.ca}:${pairId}:${run.value_type}`,pairIds,positionId:cycle?.id??null,orderId:selected?.id??null,
   from,to:Math.max(to,from+step),start,end,fib,fibFrom,fibTo:Math.max(to,fibFrom+step),
   events:pairEvents.map(o=>({id:o.id,pairId:o.pair_id,side:o.side,reason:o.reason,time:Number(o.fill_time),value:Number(o.fill_value),quantity:Number(o.quantity),status:'filled'})),
   decision:cycle?null:{id:selected.id,status:selected.status,side:selected.side,reason:selected.reason,time:Number(selected.decision_time),bucket:start,value:Number(selected.decision_value),pairId:selected.pair_id}};
 }
 @Get('live-runs/:id/markers') async markers(@Param('id') id:string,@Query() q:Record<string,string>){
  const run=(await this.pool.query('SELECT id FROM live_runs WHERE id=$1',[id])).rows[0];if(!run)throw new BadRequestException('任务不存在');
  const from=Number(q.from??0),to=Number(q.to??Date.now());if(!Number.isFinite(from)||!Number.isFinite(to)||to<from)throw new BadRequestException('时间范围无效');
  const page=Math.max(1,Number(q.page)||1),size=Math.min(500,Math.max(1,Number(q.pageSize)||500));
  const step=(await this.pool.query('SELECT interval FROM live_runs WHERE id=$1',[id])).rows[0].interval==='30s'?30_000:60_000;
  const rows=(await this.pool.query(`SELECT o.id,o.chain,o.ca,o.pair_id,o.side,o.reason,o.status,o.position_id,o.decision_time,o.decision_value,
    f.fill_time,f.fill_value,f.quantity FROM live_orders o LEFT JOIN live_fills f ON f.order_id=o.id
    WHERE o.run_id=$1 AND ($2::text IS NULL OR o.chain=$2) AND ($3::text IS NULL OR o.ca=$3) AND ($4::text IS NULL OR o.pair_id=$4)
    AND (f.fill_time BETWEEN $5::bigint AND ($6::bigint+$7::bigint) OR (f.fill_time IS NULL AND o.status<>'filled' AND o.decision_time BETWEEN ($5::bigint-$7::bigint) AND ($6::bigint+$7::bigint)))
    ORDER BY COALESCE(f.fill_time,o.decision_time),o.id`,[id,q.chain??null,q.ca??null,q.pairId??null,from,to,step])).rows;
  const items=rows.map(o=>{const filled=o.fill_time!=null,actual=Number(filled?o.fill_time:o.decision_time),time=filled?Math.floor(actual/step)*step:decisionBucket(actual,o.reason,step);
   const side=o.side==='buy'?'买入':'卖出',label=filled?(o.reason==='add'?'加仓':o.side==='buy'?'买入':'卖出'):`${side}决策（${({pending:'待执行',submitted:'已提交',unknown:'待核实',failed:'失败',cancelled:'已取消'} as Record<string,string>)[o.status]??'未成交'}）`;
   return {id:o.id,chain:o.chain,ca:o.ca,pair_id:o.pair_id,time,actual_time:actual,price:Number(filled?o.fill_value:o.decision_value),quantity:filled?Number(o.quantity):null,
    signal_type:filled?(o.side==='buy'?(o.reason==='add'?'add':'entry'):o.reason):'decision',event_label:label,status:o.status,
    reason_json:{message:`${label} · ${filled?'实际成交':'策略决策'}时间 ${new Date(actual).toISOString()} · ${o.reason}`}};
  }).filter(o=>o.time>=from&&o.time<=to);
  if(q.chain&&q.ca){
   const history=(await this.pool.query(`SELECT o.id,o.chain,o.ca,o.position_id,o.side,o.reason FROM live_orders o JOIN live_fills f ON f.order_id=o.id
    WHERE o.run_id=$1 AND o.chain=$2 AND o.ca=$3 AND o.status='filled' ORDER BY f.fill_time,o.decision_time,o.id`,[id,q.chain,q.ca])).rows;
   const sequence=new Map<string,number>(),labels=new Map<string,string>(),cycleLabels=new Map<string,{no:number;adds:number}>();
   for(const o of history){const key=`${o.chain}:${o.ca}`,cycleKey=String(o.position_id??o.id);let cycle=cycleLabels.get(cycleKey);
    if(o.side==='buy'&&(!cycle||o.reason!=='add'&&!o.position_id)){cycle={no:(sequence.get(key)??0)+1,adds:0};sequence.set(key,cycle.no);cycleLabels.set(cycleKey,cycle);}
    if(!cycle)continue;
    if(o.side==='buy'&&o.reason==='add')labels.set(o.id,`加${cycle.no}.${++cycle.adds}`);
    else labels.set(o.id,`${o.side==='buy'?'买':'卖'}${cycle.no}`);
   }
   for(const item of items)if(item.status==='filled'&&labels.has(item.id))item.event_label=labels.get(item.id)!;
  }
  return {items:items.slice((page-1)*size,page*size),total:items.length};
 }
 @Get('live-runs/:id/external-signals') async externalSignals(@Param('id') id:string,@Query() q:Record<string,string>){
  const page=Math.max(1,Number(q.page)||1),size=Math.min(500,Math.max(1,Number(q.pageSize)||500));
  const rows=(await this.pool.query(`SELECT e.id,e.chain,e.ca,e.pair_id,e.event_time AS "signalTime",e.payload->>'source' AS "signalSource",e.payload AS "sourceSignal",
    ROW_NUMBER() OVER(PARTITION BY e.chain,e.ca ORDER BY e.event_time,e.id)=1 AS first,COUNT(*) OVER() AS total
    FROM live_events e WHERE e.run_id=$1 AND e.kind='external_signal' AND ($2::text IS NULL OR e.chain=$2) AND ($3::text IS NULL OR e.ca=$3) AND ($4::text IS NULL OR e.pair_id=$4)
    AND e.event_time BETWEEN $5 AND $6 ORDER BY e.event_time,e.id LIMIT $7 OFFSET $8`,[id,q.chain??null,q.ca??null,q.pairId??null,Number(q.from??0),Number(q.to??Date.now()),size,(page-1)*size])).rows;
  return {items:rows,total:Number(rows[0]?.total??0)};
 }
 @Get('live-runs/:id/equity') async equity(@Param('id') id:string){
  return (await this.pool.query('SELECT time,equity,cash,unrealized FROM live_equity_curve WHERE run_id=$1 ORDER BY time DESC LIMIT 1000',[id])).rows.reverse();
 }
 @Post('live-runs/:id/start') async start(@Param('id') id:string,@Headers('x-live-admin-password') password:string,@Req() request:any){
  const existing=(await this.pool.query('SELECT mode,chain,wallet_address FROM live_runs WHERE id=$1',[id])).rows[0];
  if(!existing)throw new BadRequestException('实时任务不存在');
  if(existing.mode==='live'){
   requireLiveAdmin(password,request);
   if(process.env.LIVE_TRADING_ENABLED!=='true' || !process.env.XXYY_API_KEY)throw new ConflictException('实盘全局开关未启用或 XXYY API Key 未配置');
   const conflict=(await this.pool.query("SELECT id FROM live_runs WHERE id<>$1 AND mode='live' AND chain=$2 AND lower(wallet_address)=lower($3) LIMIT 1",[id,existing.chain,existing.wallet_address])).rows;
   if(conflict.length)throw new ConflictException('该链钱包已被其他实盘任务占用');
  }
  if(!process.env.MEMEINFO_SIGNAL_TOKEN)throw new ConflictException('实时信号令牌尚未配置');
  const result=await this.pool.query("UPDATE live_runs SET status='running',feed_state='connecting',started_at=COALESCE(started_at,now()),error_message=NULL,updated_at=now() WHERE id=$1 AND status IN ('paused','running') RETURNING *",[id]);
  if(!result.rowCount)throw new ConflictException('任务不是可启动状态');
  return publicRow(result.rows[0]);
 }
 @Post('live-runs/:id/pause') async pause(@Param('id') id:string,@Headers('x-live-admin-password') password:string,@Req() request:any){
  const current=(await this.pool.query('SELECT mode FROM live_runs WHERE id=$1',[id])).rows[0];if(!current)throw new BadRequestException('任务不存在');
  if(current.mode==='live')requireLiveAdmin(password,request);
  const result=await this.pool.query("UPDATE live_runs SET status='paused',feed_state='paused',updated_at=now() WHERE id=$1 AND status IN ('running','paused') RETURNING *",[id]);
  if(!result.rowCount)throw new ConflictException('任务不能暂停');return publicRow(result.rows[0]);
 }
 @Post('live-runs/:id/stop') async stop(@Param('id') id:string,@Headers('x-live-admin-password') password:string,@Req() request:any){
  const current=(await this.pool.query('SELECT mode FROM live_runs WHERE id=$1',[id])).rows[0];if(!current)throw new BadRequestException('任务不存在');
  if(current.mode==='live')requireLiveAdmin(password,request);
  const result=await this.pool.query("UPDATE live_runs SET status='stopped',feed_state='paused',updated_at=now() WHERE id=$1 AND status<>'stopped' RETURNING *",[id]);
  return publicRow(result.rows[0]??(await this.pool.query('SELECT * FROM live_runs WHERE id=$1',[id])).rows[0]);
 }
}
