export const eventLabels:Record<string,string>={entry:'首次买入',add:'加仓',take_profit:'止盈卖出',stop_loss:'止损卖出',profit_lock:'动态锁盈',invalidation:'失效退出',timeout:'超时退出',end_of_backtest:'结束平仓',risk_event:'风险事件'};
export const invalidationLabels:Record<string,string>={break_fib_invalidation:'跌破 Fib',break_swing_low_invalidation:'跌破前低',bearish_volume_invalidation:'放量大阴线',other_condition:'其他配置条件',unknown:'历史原因未明'};
Object.entries(invalidationLabels).forEach(([code,label])=>{eventLabels[`invalidation:${code}`]=`失效 · ${label}`;});
export function exitLabel(record:any){
 const type=record.signal_type ?? record.exit_reason;
 if(type!=='invalidation')return eventLabels[type] || '历史退出信息不可用';
 const detail=record.invalidation_detail ?? record.reason_json?.invalidation;
 const names=[...new Set<string>((detail?.matches ?? []).map((m:any)=>invalidationLabels[m.code] ?? invalidationLabels.other_condition))];
 return names.length?names.join('、')+'退出':'失效退出（历史原因未明）';
}
export function invalidationEvidence(detail:any){
 if(!detail || detail.source==='unavailable')return [detail?.message || '历史细分原因未记录，无法可靠还原'];
 return (detail.matches ?? []).map((m:any)=>{
  const o=m.observed ?? {},t=m.thresholds ?? {},p=m.parameters ?? {};
  if(m.code==='break_fib_invalidation')return `Fib ${p.ratio}（缓冲 ${p.bufferPercent ?? 0}%）：收盘 ${preciseValue(o.close)} < 失效阈值 ${preciseValue(t.closeBelow)}`;
  if(m.code==='break_swing_low_invalidation')return `前低 ${preciseValue(o.swingLow)}（缓冲 ${p.bufferPercent ?? 0}%）：收盘 ${preciseValue(o.close)} < 失效阈值 ${preciseValue(t.closeBelow)}`;
  if(m.code==='bearish_volume_invalidation')return `阴线实体跌幅 ${formatNumber(o.bodyPercent)}% ≥ ${formatNumber(t.minBodyPercent)}%；成交量 ${formatNumber(o.volume)} ≥ 前 ${p.period} 根内可用均量 ${formatNumber(o.baselineVolume)} × ${formatNumber(p.minRatio)}`;
  return `其他已满足条件：${p.type ?? '不可用'}`;
 });
}
export const numberDisplay={decimals:2,smallSignificantDigits:6,locale:'zh-CN',missing:'不可用'} as const;
const numeric=(value:unknown)=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
export function formatNumber(value:unknown,options:{small?:boolean;signed?:boolean;grouping?:boolean}={}){
 if(!numeric(value))return numberDisplay.missing;
 const n=Number(value),small=options.small&&n!==0&&Math.abs(n)<10**-numberDisplay.decimals;
 const rounded=small?n:Number(n.toFixed(numberDisplay.decimals)),safe=Object.is(rounded,-0)?0:rounded;
 const text=safe.toLocaleString(numberDisplay.locale,{useGrouping:options.grouping!==false,...(small?{maximumSignificantDigits:numberDisplay.smallSignificantDigits}:{minimumFractionDigits:numberDisplay.decimals,maximumFractionDigits:numberDisplay.decimals})});
 return options.signed&&safe>0?'+'+text:text;
}
export const preciseValue=(value:unknown)=>formatNumber(value,{small:true});
export const signedValue=(value:unknown)=>formatNumber(value,{signed:true});
export function valueTone(value:unknown,adverse=false){return !numeric(value)||Number(value)===0?'value-neutral':adverse||Number(value)<0?'value-negative':'value-positive';}
export function marketValue(value:number){
 if(!Number.isFinite(value))return '不可用';
 const n=Math.abs(value);return n>=1e6?formatNumber(value/1e6,{grouping:false})+'M':n>=1e3?formatNumber(value/1e3,{grouping:false})+'K':formatNumber(value,{grouping:false});
}
export function changePercent(value:number,entry:number){return Number.isFinite(value)&&Number.isFinite(entry)&&entry>0?(value/entry-1)*100:null;}
export function duration(ms:number|null|undefined){
 if(ms==null || !Number.isFinite(ms))return '不可用';
 const seconds=Math.max(0,Math.floor(ms/1000));const d=Math.floor(seconds/86400),h=Math.floor(seconds%86400/3600),m=Math.floor(seconds%3600/60),s=seconds%60;
 return [d?`${d}天`:'',h?`${h}小时`:'',m?`${m}分`:'',`${s}秒`].filter(Boolean).join(' ');
}
