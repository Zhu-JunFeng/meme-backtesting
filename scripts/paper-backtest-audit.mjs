/** Reproduce the bought pools of one paper run without changing that run or its strategy. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {poolKey,validCandle} from '../packages/engine/dist/index.js';

const require=createRequire(new URL('../apps/api/package.json',import.meta.url));
const {Client}=require('pg');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uuid=value=>{const h=hash(value).slice(0,32);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
const key=row=>`${row.chain}:${row.ca}`;
const pairKey=row=>`${key(row)}:${row.pair_id}`;
const number=value=>value==null?null:Number(value);

export function selectBoughtPools(orders,watches,events,cutoff){
 const filledBuys=orders.filter(o=>o.side==='buy'&&o.status==='filled'&&number(o.fill_time)<=cutoff);
 const pairs=[...new Map(filledBuys.map(o=>[pairKey(o),{chain:o.chain,ca:o.ca,pairId:o.pair_id}])).values()].sort((a,b)=>`${a.chain}:${a.ca}:${a.pairId}`.localeCompare(`${b.chain}:${b.ca}:${b.pairId}`));
 const gates=[];
 for(const ca of [...new Set(filledBuys.map(key))].sort()){
  const buy=filledBuys.filter(o=>key(o)===ca).sort((a,b)=>number(a.decision_time)-number(b.decision_time))[0];
  const watch=watches.find(w=>key(w)===ca);
  const candidates=events.filter(e=>e.kind==='external_signal'&&key(e)===ca&&number(e.event_time)<=number(buy.decision_time)).sort((a,b)=>number(a.event_time)-number(b.event_time));
  const matching=watch&&candidates.find(e=>number(e.event_time)===number(watch.signal_time));
  const chosen=matching??candidates.at(-1);
  if(!chosen)throw Error(`模拟盘买入 ${ca} 缺少当时已收到的外部信号，拒绝猜测入场门槛`);
  const signalTime=number(chosen.event_time);
  if(number(buy.decision_time)<=signalTime)throw Error(`模拟盘买入 ${ca} 未严格晚于外部信号`);
  gates.push({chain:buy.chain,ca:buy.ca,signalTime,sourceSignal:chosen.payload??{},sourceEventId:String(chosen.id),signalSource:chosen.payload?.source??watch?.signal_source??'unknown'});
 }
 return {pairs,gates,filledBuys};
}

export function auditOrders(orders,gates,cutoff){
 const byCa=new Map(gates.map(g=>[key(g),g.signalTime]));
 const filled=orders.filter(o=>o.status==='filled'&&number(o.fill_time)<=cutoff);
 const issues=[];
 for(const order of filled){
  if(!Number.isFinite(number(order.decision_time))||!Number.isFinite(number(order.fill_time))||number(order.fill_time)<number(order.decision_time))issues.push({orderId:order.id,issue:'成交早于决策或时间无效'});
  if(order.side==='buy'&&number(order.decision_time)<=byCa.get(key(order)))issues.push({orderId:order.id,issue:'买入未严格晚于任务信号'});
  if(!(number(order.fill_value)>0)||!(number(order.fill_price)>0)||!(number(order.quantity)>0))issues.push({orderId:order.id,issue:'成交值、币价或数量无效'});
 }
 return {filledOrders:filled.length,filledBuys:filled.filter(o=>o.side==='buy').length,filledSells:filled.filter(o=>o.side==='sell').length,issues};
}

function liveCycles(orders,cutoff){
 const filled=orders.filter(o=>o.status==='filled'&&number(o.fill_time)<=cutoff).sort((a,b)=>number(a.fill_time)-number(b.fill_time)||a.id.localeCompare(b.id));
 const map=new Map(),cycles=[];
 for(const o of filled){
  const id=o.position_id??pairKey(o),bucket=map.get(id);
  if(o.side==='buy'&&o.reason!=='add'){
   const cycle={chain:o.chain,ca:o.ca,pairId:o.pair_id,buy:o,sell:null,adds:[]};cycles.push(cycle);map.set(id,cycle);
  }else if(o.side==='buy'&&bucket)bucket.adds.push(o);
  else if(o.side==='sell'&&bucket)bucket.sell=o;
 }
 return cycles;
}

export function compareTrades(orders,trades,step,cutoff){
 const cycles=liveCycles(orders,cutoff),byPool=new Map();
 for(const trade of trades){const k=`${trade.chain}:${trade.ca}:${trade.pair_id}`;if(!byPool.has(k))byPool.set(k,[]);byPool.get(k).push(trade);}
 for(const rows of byPool.values())rows.sort((a,b)=>number(a.entry_time)-number(b.entry_time));
 const items=[];
 for(const cycle of cycles){
  const rows=byPool.get(`${cycle.chain}:${cycle.ca}:${cycle.pairId}`)??[];
  const candleTime=Math.floor(number(cycle.buy.decision_time)/step)*step;
  let best=-1,bestDistance=Infinity;
  for(let i=0;i<rows.length;i++){const distance=Math.abs(number(rows[i].entry_time)-candleTime);if(distance<bestDistance){best=i;bestDistance=distance;}}
  const backtest=best<0?null:rows.splice(best,1)[0];
  const entryDeltaBars=backtest?Math.round((number(backtest.entry_time)-candleTime)/step):null;
  const liveReason=cycle.sell?.reason??null,backtestReason=backtest?.exit_reason??null;
  let status='数据不足';
  if(backtest){
   if(Math.abs(entryDeltaBars)<=1&&liveReason===backtestReason)status='吻合';
   else if(backtestReason==='end_of_backtest')status='可解释差异';
   else status='疑似异常';
  }
  items.push({status,chain:cycle.chain,ca:cycle.ca,pairId:cycle.pairId,
   live:{buyDecisionTime:number(cycle.buy.decision_time),buyFillTime:number(cycle.buy.fill_time),buyValue:number(cycle.buy.fill_value),sellDecisionTime:number(cycle.sell?.decision_time),sellFillTime:number(cycle.sell?.fill_time),sellValue:number(cycle.sell?.fill_value),exitReason:liveReason,positionId:cycle.buy.position_id??cycle.buy.id},
   backtest:backtest?{tradeNo:number(backtest.trade_no),entryTime:number(backtest.entry_time),entryValue:number(backtest.entry_price),exitTime:number(backtest.exit_time),exitValue:number(backtest.exit_price),exitReason:backtestReason,netPnl:number(backtest.net_pnl)}:null,
   entryDeltaBars,reasonMatches:liveReason===backtestReason});
 }
 const backtestOnly=[...byPool.values()].flat().map(t=>({chain:t.chain,ca:t.ca,pairId:t.pair_id,entryTime:number(t.entry_time),exitTime:number(t.exit_time),exitReason:t.exit_reason,netPnl:number(t.net_pnl)}));
 return {items,backtestOnly,summary:{liveCycles:cycles.length,matched:items.filter(i=>i.status==='吻合').length,explainable:items.filter(i=>i.status==='可解释差异').length,suspected:items.filter(i=>i.status==='疑似异常').length,insufficient:items.filter(i=>i.status==='数据不足').length,backtestOnly:backtestOnly.length}};
}

async function snapshotEvidence(db,paperId,cutoff){
 const run=(await db.query("SELECT * FROM live_runs WHERE id=$1 AND mode='paper'",[paperId])).rows[0];
 if(!run)throw Error('指定模拟盘任务不存在');
 const watches=(await db.query('SELECT * FROM live_watches WHERE run_id=$1',[paperId])).rows;
 const orders=(await db.query(`SELECT o.id,o.position_id,o.chain,o.ca,o.pair_id,o.side,o.reason,o.status,o.decision_time,o.decision_value,o.requested_amount,f.fill_time,f.fill_value,f.fill_price,f.quantity,f.gross_amount,f.fee,f.slippage_cost,f.tax_cost FROM live_orders o LEFT JOIN live_fills f ON f.order_id=o.id WHERE o.run_id=$1 AND o.decision_time<=$2 ORDER BY o.decision_time,o.id`,[paperId,cutoff])).rows;
 const events=(await db.query("SELECT id,chain,ca,pair_id,kind,event_time,payload FROM live_events WHERE run_id=$1 AND kind='external_signal' AND event_time<=$2 ORDER BY event_time,id",[paperId,cutoff])).rows;
 const selected=selectBoughtPools(orders,watches,events,cutoff);
 if(!selected.pairs.length)throw Error('当前任务无实际买入，不能创建空对照回测');
 const orderAudit=auditOrders(orders,selected.gates,cutoff);
 if(orderAudit.issues.length)throw Error(`模拟盘订单时序或成交字段存在 ${orderAudit.issues.length} 项问题，暂停提交：${JSON.stringify(orderAudit.issues)}`);
 const evidenceHash=hash({paperId,cutoff,strategyVersionId:run.strategy_version_id,strategyJson:run.strategy_json,pairs:selected.pairs,gates:selected.gates,orders});
 return {run,watches,orders,events,selected,orderAudit,evidenceHash};
}

async function candlesFor(db,symbol,run,cutoff){
 const step=run.interval==='30s'?30_000:60_000;
 const rows=(await db.query(`SELECT open_time AS time,close_time AS "closeTime",open,high,low,close,volume FROM public.meme_kline WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND valid IS DISTINCT FROM false AND open_time+$6<=$7 AND close_time<=$7 ORDER BY open_time`,[symbol.chain,symbol.ca,symbol.pairId,run.interval,run.value_type,step,cutoff])).rows;
 return rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v)]))).filter(validCandle).map(row=>({...row,valid:true}));
}

async function prepare(db,paperId,cutoff,{submit=false,api='http://127.0.0.1:3000/api'}={}){
 assert(Number.isSafeInteger(cutoff)&&cutoff>0&&cutoff<=Date.now(),'截止时间必须是当前或过去的 Unix 毫秒');
 await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
 try{
  const evidence=await snapshotEvidence(db,paperId,cutoff);
  const {run,selected,orderAudit,evidenceHash}=evidence,step=run.interval==='30s'?30_000:60_000;
  const inputs=[];let totalCandles=0;
  for(const symbol of selected.pairs){const candles=await candlesFor(db,symbol,run,cutoff);totalCandles+=candles.length;if(totalCandles>1_000_000)throw Error('对照输入超过 100 万根 K 线，请缩小范围后重试');inputs.push({symbol,candles});}
  const pools=inputs.map(({symbol,candles})=>({...symbol,startTime:candles[0]?.time??null,endTime:candles.at(-1)?.time??null,noData:!candles.length}));
  if(pools.every(p=>p.noData))throw Error('全部已买入交易池缺少可用历史 K 线');
  const dataHash=hash(inputs),id=uuid({kind:'paper-backtest-audit-v1',paperId,cutoff,evidenceHash,dataHash});
  const description=(await db.query('SELECT template_id,description_json FROM backtest_strategy_versions WHERE id=$1',[run.strategy_version_id])).rows[0];
  if(!description)throw Error('模拟盘引用的策略版本不存在');
  const signalEvents=selected.gates.map(g=>({id:g.sourceEventId,chain:g.chain,ca:g.ca,signalSource:g.signalSource,signalTime:g.signalTime,sourceSignal:g.sourceSignal,basis:'snapshot'}));
  const dataset={symbols:selected.pairs,pools,interval:run.interval,valueType:run.value_type,startTime:new Date(Math.min(...pools.filter(p=>!p.noData).map(p=>p.startTime))).toISOString(),endTime:new Date(cutoff).toISOString(),entrySignals:selected.gates.map(({chain,ca,signalTime})=>({chain,ca,signalTime})),externalSignals:signalEvents,selection:{symbols:selected.pairs,interval:run.interval,valueType:run.value_type,paperAudit:{paperId,cutoff,evidenceHash,dataHash}},signalSelection:{enabled:true,excluded:[],noOpportunity:pools.filter(p=>!p.noData&&p.endTime<=selected.gates.find(g=>key(g)===key(p)).signalTime).map(({chain,ca,pairId})=>({chain,ca,pairId}))}};
  const name=`模拟盘对照 · ${run.name} · ${new Date(cutoff).toISOString()}`;
  const config={...run.strategy_json,...dataset,name,strategyTemplateId:description.template_id,strategyVersionId:run.strategy_version_id};
  const summary={id,paperId,cutoff,name,mode:submit?'submitted':'dry-run',strategyVersionId:run.strategy_version_id,chain:run.chain,interval:run.interval,valueType:run.value_type,pairs:pools.length,cas:new Set(pools.map(key)).size,noDataPools:pools.filter(p=>p.noData).length,totalCandles,orderAudit,evidenceHash,dataHash,feedState:run.feed_state,feedReason:run.feed_reason};
  if(!submit){await db.query('ROLLBACK');return summary;}
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[id]);
  const existing=(await db.query('SELECT id,config_json,input_ready FROM backtest_runs WHERE id=$1',[id])).rows[0];
  if(existing){assert.deepEqual(existing.config_json,config,'同 ID 已有不同快照，拒绝覆盖');assert(existing.input_ready,'同 ID 任务冻结输入不完整');await db.query('COMMIT');return {...summary,mode:'existing'};}
  await db.query("INSERT INTO backtest_runs(id,name,status,config_json,strategy_template_id,strategy_version_id,dataset_json,runtime_version,queue_scope,phase,strategy_description_json) VALUES($1,$2,'stopped',$3,$4,$5,$6,'checkpoint-1','meme-production-v3','freezing',$7)",[id,name,JSON.stringify(config),description.template_id,run.strategy_version_id,JSON.stringify(dataset),JSON.stringify(description.description_json??null)]);
  for(const {symbol,candles} of inputs){
   const chunks=[];for(let n=0;n<candles.length;n+=256)chunks.push(candles.slice(n,n+256));
   for(let n=0;n<chunks.length;n+=64){const batch=chunks.slice(n,n+64),values=batch.flatMap((chunk,j)=>[id,poolKey(symbol),n+j,JSON.stringify(chunk)]);await db.query(`INSERT INTO backtest_input_chunks(run_id,pool_key,chunk_no,candles_json) VALUES ${batch.map((_,j)=>`($${j*4+1},$${j*4+2},$${j*4+3},$${j*4+4})`).join(',')}`,values);}
   let normalized=0;for(let n=0;n<candles.length;n++)normalized+=n?Math.max(1,Math.ceil((candles[n].time-candles[n-1].time)/step)):1;
   await db.query('INSERT INTO backtest_input_pools(run_id,pool_key,symbol_json,chunk_count,candle_count,normalized_count,invalid_count) VALUES($1,$2,$3,$4,$5,$6,0)',[id,poolKey(symbol),JSON.stringify(symbol),chunks.length,candles.length,normalized]);
  }
  await db.query("UPDATE backtest_runs SET input_ready=true,phase='computing' WHERE id=$1",[id]);
  await db.query('COMMIT');
  const response=await fetch(`${api.replace(/\/$/,'')}/backtests/${id}/retry`,{method:'POST',signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw Error(`冻结输入已保存为 stopped 任务 ${id}，但入队失败：HTTP ${response.status}；可安全手动重试`);
  return summary;
 }catch(error){try{await db.query('ROLLBACK');}catch{}throw error;}
}

async function compare(db,paperId,backtestId){
 const run=(await db.query('SELECT * FROM backtest_runs WHERE id=$1',[backtestId])).rows[0];
 if(!run)throw Error('对照回测不存在');
 if(run.config_json?.selection?.paperAudit?.paperId!==paperId)throw Error('对照任务与模拟盘 ID 不匹配');
 const cutoff=run.config_json.selection.paperAudit.cutoff;
 const orders=(await db.query(`SELECT o.id,o.position_id,o.chain,o.ca,o.pair_id,o.side,o.reason,o.status,o.decision_time,f.fill_time,f.fill_value,f.fill_price,f.quantity,f.gross_amount,f.fee,f.slippage_cost,f.tax_cost FROM live_orders o LEFT JOIN live_fills f ON f.order_id=o.id WHERE o.run_id=$1 AND o.decision_time<=$2 ORDER BY o.decision_time,o.id`,[paperId,cutoff])).rows;
 const trades=(await db.query('SELECT chain,ca,pair_id,trade_no,entry_time,entry_price,exit_time,exit_price,exit_reason,net_pnl FROM backtest_trades WHERE run_id=$1 ORDER BY entry_time,trade_no',[backtestId])).rows;
 const result=compareTrades(orders,trades,run.config_json.interval==='30s'?30_000:60_000,cutoff);
 const report=(await db.query('SELECT report_json FROM backtest_reports WHERE run_id=$1',[backtestId])).rows[0]?.report_json??null;
 return {paperId,backtestId,status:run.status,cutoff,report:report?{totalTrades:report.totalTrades,netPnl:report.netPnl,returnPercent:report.returnPercent,maxDrawdownPercent:report.maxDrawdownPercent}:null,...result};
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [mode,paperId,arg,...flags]=process.argv.slice(2);
 if(!['prepare','compare'].includes(mode)||!paperId||!arg||!process.env.DATABASE_URL)throw Error('用法：DATABASE_URL=... node scripts/paper-backtest-audit.mjs prepare <paperId> <cutoffMs> [--submit] | compare <paperId> <backtestId>');
 const db=new Client({connectionString:process.env.DATABASE_URL,application_name:'paper-backtest-audit'});
 try{await db.connect();const result=mode==='prepare'?await prepare(db,paperId,Number(arg),{submit:flags.includes('--submit'),api:process.env.BACKTEST_API_URL}):await compare(db,paperId,arg);console.log(JSON.stringify(result));}
 finally{await db.end();}
}
