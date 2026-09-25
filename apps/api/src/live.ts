import {BadRequestException,ConflictException,Controller,Get,Headers,Param,Post,Body,Query,Req} from '@nestjs/common';
import {scryptSync,timingSafeEqual} from 'node:crypto';
import {Pool} from 'pg';
import type {StrategyConfig} from '@meme/domain';

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
  const rows=(await this.pool.query('SELECT id,name,mode,chain,interval,value_type,signal_source,strategy_version_id,initial_capital,wallet_address,risk_json,status,cash,realized_pnl,started_at,heartbeat_at,error_message,created_at,updated_at FROM live_runs WHERE ($1::text IS NULL OR mode=$1) ORDER BY created_at DESC LIMIT 300',[mode??null])).rows;
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
  const result=await this.pool.query("UPDATE live_runs SET status='paused',updated_at=now(),error_message='管理员紧急停止：不再产生新订单' WHERE mode='live' AND status='running' RETURNING id");
  return {stopped:result.rows.map(r=>r.id)};
 }
 @Get('live-runs/:id') async one(@Param('id') id:string){
  const result=await this.pool.query('SELECT * FROM live_runs WHERE id=$1',[id]);
  if(!result.rowCount)throw new BadRequestException('实时任务不存在');
  const [watches,orders,events]=await Promise.all([
   this.pool.query('SELECT chain,ca,pair_id,signal_source,signal_time,status,last_candle_time,state_json FROM live_watches WHERE run_id=$1 ORDER BY created_at DESC LIMIT 500',[id]),
   this.pool.query('SELECT o.*,f.fill_time,f.fill_price,f.quantity,f.gross_amount,f.fee,f.slippage_cost,f.tax_cost FROM live_orders o LEFT JOIN live_fills f ON f.order_id=o.id WHERE o.run_id=$1 ORDER BY o.created_at DESC LIMIT 500',[id]),
   this.pool.query('SELECT kind,chain,ca,pair_id,event_time,payload FROM live_events WHERE run_id=$1 ORDER BY event_time DESC LIMIT 200',[id])]);
  return {run:publicRow(result.rows[0]),watches:watches.rows.map(r=>({...r,state_json:{position:r.state_json?.position??null}})),orders:orders.rows.map(r=>({...r,raw_result:undefined})),events:events.rows};
 }
 @Get('live-runs/:id/markers') async markers(@Param('id') id:string,@Query() q:Record<string,string>){
  const run=(await this.pool.query('SELECT id FROM live_runs WHERE id=$1',[id])).rows[0];if(!run)throw new BadRequestException('任务不存在');
  const from=Number(q.from??0),to=Number(q.to??Date.now());if(!Number.isFinite(from)||!Number.isFinite(to)||to<from)throw new BadRequestException('时间范围无效');
  const page=Math.max(1,Number(q.page)||1),size=Math.min(500,Math.max(1,Number(q.pageSize)||500));
  const rows=(await this.pool.query(`SELECT o.id,o.chain,o.ca,o.pair_id,
    (f.fill_time / CASE WHEN r.interval='30s' THEN 30000::bigint ELSE 60000::bigint END)
      * CASE WHEN r.interval='30s' THEN 30000::bigint ELSE 60000::bigint END AS time,
    f.fill_time AS actual_time,f.fill_value AS price,f.quantity,COUNT(*) OVER() AS total,
    CASE WHEN o.side='buy' THEN CASE WHEN o.reason='add' THEN 'add' ELSE 'entry' END ELSE o.reason END AS signal_type,
    o.reason AS event_label FROM live_orders o JOIN live_runs r ON r.id=o.run_id JOIN live_fills f ON f.order_id=o.id
    WHERE o.run_id=$1 AND ($2::text IS NULL OR o.chain=$2) AND ($3::text IS NULL OR o.ca=$3) AND ($4::text IS NULL OR o.pair_id=$4)
    AND f.fill_time BETWEEN $5 AND ($6 + CASE WHEN r.interval='30s' THEN 29999 ELSE 59999 END)
    ORDER BY f.fill_time,o.id LIMIT $7 OFFSET $8`,[id,q.chain??null,q.ca??null,q.pairId??null,from,to,size,(page-1)*size])).rows;
  return {items:rows.map(r=>({...r,reason_json:{message:`${r.event_label} · 实际成交时间 ${new Date(Number(r.actual_time)).toISOString()}`}})),total:Number(rows[0]?.total??0)};
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
  const result=await this.pool.query("UPDATE live_runs SET status='running',started_at=COALESCE(started_at,now()),error_message=NULL,updated_at=now() WHERE id=$1 AND status IN ('paused','running') RETURNING *",[id]);
  if(!result.rowCount)throw new ConflictException('任务不是可启动状态');
  return publicRow(result.rows[0]);
 }
 @Post('live-runs/:id/pause') async pause(@Param('id') id:string,@Headers('x-live-admin-password') password:string,@Req() request:any){
  const current=(await this.pool.query('SELECT mode FROM live_runs WHERE id=$1',[id])).rows[0];if(!current)throw new BadRequestException('任务不存在');
  if(current.mode==='live')requireLiveAdmin(password,request);
  const result=await this.pool.query("UPDATE live_runs SET status='paused',updated_at=now() WHERE id=$1 AND status IN ('running','paused') RETURNING *",[id]);
  if(!result.rowCount)throw new ConflictException('任务不能暂停');return publicRow(result.rows[0]);
 }
 @Post('live-runs/:id/stop') async stop(@Param('id') id:string,@Headers('x-live-admin-password') password:string,@Req() request:any){
  const current=(await this.pool.query('SELECT mode FROM live_runs WHERE id=$1',[id])).rows[0];if(!current)throw new BadRequestException('任务不存在');
  if(current.mode==='live')requireLiveAdmin(password,request);
  const result=await this.pool.query("UPDATE live_runs SET status='stopped',updated_at=now() WHERE id=$1 AND status<>'stopped' RETURNING *",[id]);
  return publicRow(result.rows[0]??(await this.pool.query('SELECT * FROM live_runs WHERE id=$1',[id])).rows[0]);
 }
}
