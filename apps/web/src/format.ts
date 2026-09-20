export const eventLabels:Record<string,string>={entry:'首次买入',add:'加仓',take_profit:'止盈卖出',stop_loss:'止损卖出',profit_lock:'动态锁盈',invalidation:'失效退出',timeout:'超时退出',end_of_backtest:'结束平仓',risk_event:'风险事件'};
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
