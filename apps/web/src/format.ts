export const eventLabels:Record<string,string>={entry:'首次买入',add:'加仓',take_profit:'止盈卖出',stop_loss:'止损卖出',profit_lock:'动态锁盈',invalidation:'失效退出',timeout:'超时退出',end_of_backtest:'结束平仓',risk_event:'风险事件'};
export function marketValue(value:number){
 if(!Number.isFinite(value))return '不可用';
 const n=Math.abs(value);return n>=1e6?(value/1e6).toFixed(2)+'M':n>=1e3?(value/1e3).toFixed(2)+'K':value.toFixed(2);
}
export function changePercent(value:number,entry:number){return Number.isFinite(value)&&Number.isFinite(entry)&&entry>0?(value/entry-1)*100:null;}
export function duration(ms:number|null|undefined){
 if(ms==null || !Number.isFinite(ms))return '不可用';
 const seconds=Math.max(0,Math.floor(ms/1000));const d=Math.floor(seconds/86400),h=Math.floor(seconds%86400/3600),m=Math.floor(seconds%3600/60),s=seconds%60;
 return [d?`${d}天`:'',h?`${h}小时`:'',m?`${m}分`:'',`${s}秒`].filter(Boolean).join(' ');
}
