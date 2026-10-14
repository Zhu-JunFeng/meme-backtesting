export type CapitalPoint={time:number;equity:number;cash?:number;unrealized?:number};
/** Display sampling only: retain endpoints and bucket extrema, never alter accounting. */
export function sampleCapital(points:CapitalPoint[],buckets=450):CapitalPoint[]{
 if(points.length<=buckets*4)return points;
 const result=new Map<number,CapitalPoint>();
 for(let i=0;i<buckets;i++){
  const group=points.slice(Math.floor(i*points.length/buckets),Math.floor((i+1)*points.length/buckets));
  if(!group.length)continue;
  for(const p of [group[0],group.at(-1)!,group.reduce((a,b)=>a.equity<b.equity?a:b),group.reduce((a,b)=>a.equity>b.equity?a:b)])result.set(p.time,p);
 }
 return [...result.values()].sort((a,b)=>a.time-b.time);
}
export function realizedCapital(initial:number,start:number,closed:Array<{sellTime:number|null;realizedPnl:number}>){
 const exits=new Map<number,number>();
 for(const c of closed)if(c.sellTime!==null&&Number.isFinite(c.sellTime)&&Number.isFinite(c.realizedPnl))exits.set(c.sellTime,(exits.get(c.sellTime)??0)+c.realizedPnl);
 if(!exits.size)return {points:[] as CapitalPoint[],total:0};
 const times=[...exits.keys()].sort((a,b)=>a-b);let balance=initial;
 const points:CapitalPoint[]=[{time:Math.min(start,times[0]-1),equity:balance}];
 for(const time of times){balance+=exits.get(time)!;points.push({time,equity:balance});}
 return {points:sampleCapital(points),total:points.length};
}
