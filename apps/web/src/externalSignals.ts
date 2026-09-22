/** External discovery time is not a fill price. Bucket only for chart placement. */
export function externalBuckets(events:any[],stepMs:number,loaded:ReadonlySet<number>,range:{from:number;to:number}){
 const buckets=new Map<number,any[]>();
 for(const e of events){const t=Math.floor(e.signalTime/stepMs)*stepMs;if(!Number.isFinite(t)||!loaded.has(t)||t<range.from*1000||t>range.to*1000)continue;const rows=buckets.get(t)??[];rows.push(e);buckets.set(t,rows);}
 return [...buckets].map(([time,events])=>({time,events,label:`${events.some(e=>e.first)?'首次监控':'外部信号'}${events.length>1?` ×${events.length}`:''}`}));
}
