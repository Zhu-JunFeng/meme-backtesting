import { Pool, type PoolClient } from 'pg';
import type { BacktestConfig, Candle, SymbolRef } from '@meme/domain';
import { ResumableEngine, intervalMs, poolKey, validCandle, type EngineBatch, type EngineCheckpoint, type Tick } from '@meme/engine';
import { configHash, fenced, heartbeat, LostLease, queuePrefix, RUNTIME_VERSION } from './index.js';

const CHUNK=256;
type Cursor={chunk:number;offset:number;previous?:Candle};
type Saved={engine:EngineCheckpoint;readers:Record<string,Cursor>;inputVersion:string};
class Interrupted extends Error {}
export class FrozenReader {
 private cache:Candle[]=[];private loaded=-1;
 constructor(private pool:Pool,readonly runId:string,readonly key:string,readonly chunks:number,readonly step:number,readonly cursor:Cursor={chunk:0,offset:0}){}
 private async raw():Promise<Candle|undefined>{
  if(this.cursor.chunk>=this.chunks)return;
  if(this.loaded!==this.cursor.chunk){const r=await this.pool.query('SELECT candles_json FROM backtest_input_chunks WHERE run_id=$1 AND pool_key=$2 AND chunk_no=$3',[this.runId,this.key,this.cursor.chunk]);if(!r.rowCount)throw new Error('冻结行情分块缺失');this.cache=r.rows[0].candles_json;this.loaded=this.cursor.chunk;}
  return this.cache[this.cursor.offset];
 }
 async peek():Promise<{candle:Candle;last:boolean}|undefined>{
  const next=await this.raw();if(!next)return;
  const previous=this.cursor.previous;
  if(previous && previous.time+this.step<next.time){const time=previous.time+this.step,close=previous.close;return {candle:{time,closeTime:time+this.step,open:close,high:close,low:close,close,volume:0,synthetic:true,valid:true},last:false};}
  return {candle:next,last:this.cursor.chunk===this.chunks-1 && this.cursor.offset===this.cache.length-1};
 }
 consume(c:Candle){this.cursor.previous=c;if(!c.synthetic){this.cursor.offset++;if(this.cursor.offset>=this.cache.length){this.cursor.chunk++;this.cursor.offset=0;}}}
}
async function insertRows(c:PoolClient,table:string,columns:string[],rows:unknown[][]){
 for(let offset=0;offset<rows.length;offset+=500){const part=rows.slice(offset,offset+500),values=part.flat();await c.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES ${part.map((r,i)=>`(${r.map((_,j)=>'$'+(i*columns.length+j+1)).join(',')})`).join(',')}`,values);}
}
async function writeBatch(c:PoolClient,id:string,b:EngineBatch){
 await insertRows(c,'backtest_signals',['run_id','chain','ca','pair_id','time','price','signal_type','reason_json','quantity','trade_no','event_order'],b.signals.map(s=>[id,s.symbol.chain,s.symbol.ca,s.symbol.pairId,s.time,s.price,s.type,JSON.stringify(s.reason),s.quantity ?? null,s.tradeNo ?? null,s.eventOrder ?? null]));
 await insertRows(c,'backtest_trades',['run_id','chain','ca','pair_id','entry_time','entry_price','quantity','exit_time','exit_price','gross_pnl','fees','slippage_cost','tax_cost','net_pnl','exit_reason','holding_bars','adds_json','trade_no','first_entry_price','buy_amount','buy_fees','buy_slippage_cost','buy_tax_cost'],b.trades.map(t=>[id,t.symbol.chain,t.symbol.ca,t.symbol.pairId,t.entryTime,t.entryPrice,t.quantity,t.exitTime ?? null,t.exitPrice ?? null,t.grossPnl ?? null,t.fees,t.slippageCost,t.taxCost,t.netPnl ?? null,t.exitReason ?? null,t.holdingBars ?? null,JSON.stringify(t.adds),t.tradeNo ?? null,t.firstEntryPrice ?? null,t.buyAmount ?? null,t.buyFees ?? null,t.buySlippageCost ?? null,t.buyTaxCost ?? null]));
 await insertRows(c,'backtest_equity_curve',['run_id','time','equity','cash','unrealized'],b.equity.map(e=>[id,e.time,e.equity,e.cash,e.unrealized]));
}

/** Each cursor retains its statement snapshot; incomplete pools roll back on interruption. */
async function freeze(pool:Pool,id:string,epoch:number,config:BacktestConfig,check:()=>void){
 const symbols=[...new Map(config.symbols.map(s=>[poolKey(s),s])).values()];
 for(let i=0;i<symbols.length;i++){
  check();const symbol=symbols[i],key=poolKey(symbol);
  if((await pool.query('SELECT 1 FROM backtest_input_pools WHERE run_id=$1 AND pool_key=$2',[id,key])).rowCount)continue;
  const c=await pool.connect();try{
   await c.query('BEGIN');
   const snap=config.pools?.find(s=>poolKey(s)===key),from=snap?.startTime ?? (config.startTime?Date.parse(config.startTime):0),to=snap?.endTime ?? (config.endTime?Date.parse(config.endTime):Date.now());
   let after=from-1,chunk=0,count=0,invalid=0,normalized=0,previous:number|undefined;
   if(!snap?.noData)await c.query('DECLARE frozen_source NO SCROLL CURSOR FOR SELECT open_time AS time,close_time AS "closeTime",open,high,low,close,volume FROM public.meme_kline WHERE chain=$1 AND ca=$2 AND pair_id=$3 AND interval=$4 AND type=$5 AND valid IS DISTINCT FROM false AND open_time>$6 AND open_time<=$7 ORDER BY open_time',[symbol.chain,symbol.ca,symbol.pairId,config.interval,config.valueType,after,to]);
   if(!snap?.noData)for(;;){
    check();const result=await c.query(`FETCH ${CHUNK} FROM frozen_source`);
    if(!result.rowCount)break;
    const candles:Candle[]=[];
    for(const row of result.rows){const candle=Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v)])) as unknown as Candle;after=candle.time;if(!validCandle(candle)){invalid++;continue;}candle.closeTime ||= candle.time+intervalMs(config.interval);candle.valid=true;candles.push(candle);count++;normalized+=previous===undefined?1:Math.max(1,Math.ceil((candle.time-previous)/intervalMs(config.interval)));previous=candle.time;}
    if(candles.length){await c.query('INSERT INTO backtest_input_chunks VALUES($1,$2,$3,$4)',[id,key,chunk++,JSON.stringify(candles)]);}
   }
   check();
   await fenced(c,id,epoch);
   await c.query('INSERT INTO backtest_input_pools VALUES($1,$2,$3,$4,$5,$6,$7)',[id,key,JSON.stringify(symbol),chunk,count,normalized,invalid]);
   await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  await pool.query("UPDATE backtest_runs SET progress=$3,phase='freezing' WHERE id=$1 AND execution_epoch=$2 AND lease_until>now()",[id,epoch,.1*(i+1)/symbols.length]);
 }
 const r=await pool.query("UPDATE backtest_runs SET input_ready=true,phase='computing' WHERE id=$1 AND execution_epoch=$2 AND lease_until>now() AND status IN ('running','stopping') RETURNING id",[id,epoch]);if(!r.rowCount)throw new LostLease();
}

export async function executeRun(pool:Pool,id:string,shutdown:()=>boolean){
 const claimed=await pool.query("UPDATE backtest_runs SET status='running',execution_epoch=execution_epoch+1,heartbeat_at=now(),lease_until=now()+interval '60 seconds' WHERE id=$1 AND status='pending' AND runtime_version=$2 AND queue_scope=$3 RETURNING *",[id,RUNTIME_VERSION,queuePrefix()]);
 if(!claimed.rowCount)return;
 const run=claimed.rows[0],epoch=run.execution_epoch,config=run.config_json as BacktestConfig;
 let stopping=false,lost=false,heartBusy=false;let engine:ResumableEngine|undefined,readers:FrozenReader[]=[],batchNo=0,total=1;
 const check=()=>{if(lost)throw new LostLease();if(stopping || shutdown())throw new Interrupted();};
 const pulse=async()=>{if(heartBusy)return;heartBusy=true;try{stopping=(await heartbeat(pool,id,epoch))==='stopping';}catch{lost=true;}finally{heartBusy=false;}};
 const timer=setInterval(pulse,2000);
 const save=async(report?:ReturnType<ResumableEngine['finish']>)=>{
  if(!engine)return;const c=await pool.connect();try{await c.query('BEGIN');const status=await fenced(c,id,epoch);
   if(report && status!=='stopping')engine.finalizeOpenPositions();
   const batch=engine.drain();const state:Saved={engine:engine.checkpoint(),readers:Object.fromEntries(readers.map(r=>[r.key,r.cursor])),inputVersion:id};
   await c.query('INSERT INTO backtest_result_batches(run_id,batch_no,execution_epoch) VALUES($1,$2,$3)',[id,++batchNo,epoch]);await writeBatch(c,id,batch);
   await c.query('INSERT INTO backtest_checkpoints(run_id,batch_no,config_checksum,state_json) VALUES($1,$2,$3,$4) ON CONFLICT(run_id) DO UPDATE SET batch_no=excluded.batch_no,config_checksum=excluded.config_checksum,state_json=excluded.state_json,created_at=now()',[id,batchNo,configHash(config),JSON.stringify(state)]);
   if(report && status!=='stopping')await c.query('INSERT INTO backtest_reports(run_id,report_json) VALUES($1,$2)',[id,JSON.stringify(report)]);
   await c.query("UPDATE backtest_runs SET checkpoint_at=now(),progress=$3,failure_streak=0,status=CASE WHEN $4 AND status<>'stopping' THEN 'completed' ELSE status END,phase=CASE WHEN $4 AND status<>'stopping' THEN 'completed' ELSE 'computing' END,finished_at=CASE WHEN $4 AND status<>'stopping' THEN now() ELSE NULL END,lease_until=CASE WHEN $4 AND status<>'stopping' THEN NULL ELSE lease_until END WHERE id=$1 AND execution_epoch=$2",[id,epoch,report && status!=='stopping'?1:.1+.85*engine.s.processed/total,!!report]);
   await c.query('COMMIT');if(status==='stopping')stopping=true;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 };
 try{
  if(!run.input_ready)await freeze(pool,id,epoch,config,check);
  check();const saved=(await pool.query('SELECT * FROM backtest_checkpoints WHERE run_id=$1',[id])).rows[0];
  if(saved && (saved.config_checksum!==configHash(config) || saved.state_json.inputVersion!==id))throw new Error('配置或输入版本不匹配，拒绝恢复');
  const manifest=(await pool.query('SELECT * FROM backtest_input_pools WHERE run_id=$1 ORDER BY pool_key',[id])).rows;
  const expectedKeys=new Set(config.symbols.map(poolKey));if(manifest.length!==expectedKeys.size || manifest.some(r=>!expectedKeys.has(r.pool_key)))throw new Error('冻结输入清单不完整，拒绝恢复');
  total=Math.max(1,manifest.reduce((n,r)=>n+Number(r.normalized_count),0));
  engine=new ResumableEngine(config,saved?.state_json.engine);batchNo=saved?.batch_no ?? 0;
  if(!saved)engine.s.invalidBars=manifest.reduce((n,r)=>n+r.invalid_count,0);
  readers=manifest.map(r=>new FrozenReader(pool,id,r.pool_key,r.chunk_count,intervalMs(config.interval),saved?.state_json.readers[r.pool_key]));
  const symbols=new Map(manifest.map(r=>[r.pool_key,r.symbol_json as SymbolRef]));
  const heads=await Promise.all(readers.map(r=>r.peek()));let lastSave=Date.now(),lastYield=Date.now(),lastProgress=0;
  for(;;){check();let time=Infinity;for(const h of heads)if(h)time=Math.min(time,h.candle.time);if(!Number.isFinite(time))break;
   const ticks:Tick[]=[];const indices:number[]=[];for(let i=0;i<heads.length;i++)if(heads[i]?.candle.time===time){ticks.push({symbol:symbols.get(readers[i].key)!,...heads[i]!});indices.push(i);}
   engine.step(ticks);for(const i of indices){readers[i].consume(heads[i]!.candle);heads[i]=await readers[i].peek();}
   if(Date.now()-lastSave>=30000 || engine.bufferedRows>=10000){await save();lastSave=Date.now();}
   if(Date.now()-lastProgress>=2000){await pool.query("UPDATE backtest_runs SET progress=$3 WHERE id=$1 AND execution_epoch=$2 AND lease_until>now() AND status='running'",[id,epoch,.1+.85*engine.s.processed/total]);lastProgress=Date.now();}
   if(Date.now()-lastYield>=20){await new Promise<void>(r=>setImmediate(r));lastYield=Date.now();}
  }
  check();await pool.query("UPDATE backtest_runs SET phase='saving' WHERE id=$1 AND execution_epoch=$2 AND lease_until>now()",[id,epoch]);await save(engine.finish());
  if(stopping)throw new Interrupted();
 }catch(e){
  if(e instanceof LostLease || lost){console.warn('lease lost',id);return;}
  if(e instanceof Interrupted){if(engine)await save();await pool.query("UPDATE backtest_runs SET status=CASE WHEN status='stopping' THEN 'stopped' ELSE 'pending' END,finished_at=CASE WHEN status='stopping' THEN now() ELSE NULL END,lease_until=NULL,execution_epoch=execution_epoch+1,dispatch_no=dispatch_no+1,recovery_count=recovery_count+CASE WHEN status='stopping' THEN 0 ELSE 1 END WHERE id=$1 AND execution_epoch=$2 AND lease_until>now()",[id,epoch]);}
  else{await pool.query("UPDATE backtest_runs SET status='failed',error_message=$3,finished_at=now(),lease_until=NULL WHERE id=$1 AND execution_epoch=$2 AND lease_until>now()",[id,epoch,String(e)]);throw e;}
 }finally{clearInterval(timer);}
}
