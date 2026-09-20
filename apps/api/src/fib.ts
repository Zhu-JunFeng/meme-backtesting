import type { Pool } from 'pg';
import { intervalMs } from '@meme/engine';
import { loadResults } from './results.js';

/** Map normalized engine indices without materializing synthetic gaps. */
export class FibIndexMapper {
 index=-1; previous:any; points=new Map<number,any>();
 constructor(readonly wanted:number[],readonly step:number){}
 accept(c:any){
  if(this.previous){
   if(c.time<=this.previous.time)throw new Error('冻结行情顺序异常');
   const gaps=Math.max(0,Math.ceil((c.time-this.previous.time)/this.step)-1);
   for(const n of this.wanted)if(n>this.index && n<=this.index+gaps)this.points.set(n,{time:this.previous.time+(n-this.index)*this.step,low:this.previous.close,high:this.previous.close,synthetic:true});
   this.index+=gaps;
  }
  this.index++;if(this.wanted.includes(this.index))this.points.set(this.index,c);this.previous=c;
 }
}
export function fibLevels(config:any,impulse:any){
 const levels=new Map<number,{ratio:number;value:number;uses:string[]}>(),zones:any[]=[],thresholds:any[]=[];
 const value=(r:number)=>impulse.high-(impulse.high-impulse.low)*r;
 const add=(r:number,use:string)=>{if(!Number.isFinite(r))return;if(!levels.has(r))levels.set(r,{ratio:r,value:value(r),uses:[]});if(use)levels.get(r)!.uses.push(use);};
 [0,.382,.5,.618,.65,.786,.886,1].forEach(r=>add(r,r===0?'Swing High':r===1?'Swing Low':''));
 const walk=(g:any,path:string)=>{if(!g||g.enabled===false)return;if(g.conditions){g.conditions.forEach((c:any,i:number)=>walk(c,`${path} / ${g.mode}${g.mode==='at_least'?`(${g.minMatches})`:''} / ${i+1}`));return;}
  if(g.type==='fib_retracement'){add(g.zoneLow,path);add(g.zoneHigh,path);zones.push({label:path,lowRatio:g.zoneLow,highRatio:g.zoneHigh,lower:value(g.zoneHigh),upper:value(g.zoneLow)});}
  if(g.type==='break_fib_invalidation'){add(g.ratio,path);thresholds.push({label:`${path} 失效（缓冲 ${g.bufferPercent ?? 0}%）`,value:value(g.ratio)*(1-(g.bufferPercent ?? 0)/100)});}
  if(g.type==='break_swing_low_invalidation')thresholds.push({label:`${path} 前低失效（缓冲 ${g.bufferPercent ?? 0}%）`,value:impulse.low*(1-(g.bufferPercent ?? 0)/100)});
 };
 walk(config.entryConditionGroup,'入场配置');if(config.positionConfig?.mode==='pyramiding')walk(config.addConditionGroup ?? config.entryConditionGroup,'加仓配置');walk(config.invalidationConditionGroup,'失效配置');
 const stop=config.exitConfig?.stopLoss,target=config.exitConfig?.takeProfit;
 if(stop?.type==='fib_level'){add(stop.ratio,'Fib 止损基准');thresholds.push({label:`止损（缓冲 ${stop.bufferPercent ?? 0}%）`,value:value(stop.ratio)*(1-(stop.bufferPercent ?? 0)/100)});}
 if(stop?.type==='swing_low')thresholds.push({label:`前低止损（缓冲 ${stop.bufferPercent}%）`,value:impulse.low*(1-stop.bufferPercent/100)});
 if(target?.type==='fib_target')add(target.ratio,'止盈目标');if(target?.type==='previous_high')add(0,'前高止盈');
 return {levels:[...levels.values()].sort((a,b)=>a.ratio-b.ratio),zones,thresholds};
}
export async function tradeFib(pool:Pool,run:any,q:Record<string,string>,tradeId?:string,eventId?:string){
 const unavailable=(reason:string,extra:any={})=>({status:'unavailable',reason,...extra});
 const {trades,signals}=await loadResults(pool,run.id,q);
 const event=signals.find(s=>String(s.id)===String(eventId)),trade=trades.find(t=>String(t.id)===String(tradeId ?? event?.trade_id));
 // An active entry may not yet have a persisted trade row. Only explicit sequence links are usable.
 const entries=signals.filter(s=>s.signal_type==='entry' && (trade?s.trade_id===trade.id:event?.signal_type==='entry'?s.id===event.id:event?.trade_no!=null && s.trade_no===event.trade_no));
 if(entries.length!==1)return unavailable('历史 Fib 锚点无法完整还原：入场事件关联不唯一');
 const entry=entries[0],i=entry.reason_json?.impulse;
 if(!i||!Number.isFinite(i.low)||!Number.isFinite(i.high)||i.low<=0||i.high<=i.low)return unavailable('没有有效的原始 Impulse 记录');
 const buys=signals.filter(s=>['entry','add'].includes(s.signal_type)&&(trade?s.trade_id===trade.id:s.id===entry.id || entry.trade_no!=null&&s.trade_no===entry.trade_no));
 const base={tradeId:trade?.id ?? null,entryTime:Number(entry.time),exitTime:trade?.exit_time==null?null:Number(trade.exit_time),impulse:i,...fibLevels(run.config_json,i),buys:buys.map(s=>({label:s.event_label ?? s.signal_type,time:Number(s.time),value:Number(s.price),ratio:(i.high-Number(s.price))/(i.high-i.low)})),conditionGroup:entry.reason_json.conditionGroup ?? run.config_json.entryConditionGroup};
 if(![i.lowIndex,i.highIndex,i.confirmedAtIndex].every(n=>Number.isInteger(n)&&n>=0)||i.lowIndex>=i.highIndex||i.confirmedAtIndex<i.highIndex)return unavailable('历史 Fib 索引不合法',base);
 let low:any,high:any,confirmed:any,source='入场信号快照';
 if([i.lowTime,i.highTime,i.confirmedTime].every(Number.isFinite)){
  low={time:i.lowTime,low:i.low,synthetic:i.lowSynthetic};high={time:i.highTime,high:i.high,synthetic:i.highSynthetic};confirmed={time:i.confirmedTime,synthetic:i.confirmedSynthetic};
 }else{
  if(!run.input_ready)return unavailable('历史 Fib 锚点无法完整还原：没有冻结行情',base);
  const versions=await pool.query(`SELECT report_json->>'engineVersion' AS version FROM backtest_reports WHERE run_id=$1 UNION ALL SELECT state_json->'engine'->>'engineVersion' FROM backtest_checkpoints WHERE run_id=$1`,[run.id]);
  if(!versions.rows.some(r=>['portfolio-3','portfolio-4'].includes(r.version)))return unavailable('历史 Fib 锚点无法完整还原：引擎版本不支持',base);
  const mapper=new FibIndexMapper([i.lowIndex,i.highIndex,i.confirmedAtIndex],intervalMs(run.config_json.interval));let after=-1;
  for(;;){const rows=(await pool.query('SELECT chunk_no,candles_json FROM backtest_input_chunks WHERE run_id=$1 AND pool_key=$2 AND chunk_no>$3 ORDER BY chunk_no LIMIT 16',[run.id,`${q.chain}:${q.ca}:${q.pairId}`,after])).rows;if(!rows.length)break;
   for(const row of rows){if(row.chunk_no!==after+1)return unavailable('冻结行情分块缺失',base);after=row.chunk_no;for(const c of row.candles_json){try{mapper.accept(c);}catch{return unavailable('冻结行情顺序异常，无法还原锚点',base);}if(mapper.index>=i.confirmedAtIndex)break;}if(mapper.index>=i.confirmedAtIndex)break;}if(mapper.index>=i.confirmedAtIndex)break;
  }
  low=mapper.points.get(i.lowIndex);high=mapper.points.get(i.highIndex);confirmed=mapper.points.get(i.confirmedAtIndex);source='冻结行情按原引擎补齐规则还原';
 }
 const close=(a:number,b:number)=>Math.abs(a-b)<=1e-10*Math.max(Math.abs(a),Math.abs(b),Number.MIN_VALUE);
 if(!low||!high||!confirmed||!close(low.low,i.low)||!close(high.high,i.high)||low.time>=high.time||high.time>confirmed.time||confirmed.time>Number(entry.time))return unavailable('历史 Fib 锚点无法完整还原：数值或确认时间校验失败',base);
 return {...base,status:'available',source,low:{...low,value:i.low,index:i.lowIndex},high:{...high,value:i.high,index:i.highIndex},confirmed:{...confirmed,index:i.confirmedAtIndex}};
}
