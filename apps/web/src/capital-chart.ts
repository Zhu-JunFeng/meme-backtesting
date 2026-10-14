export type CapitalPoint={time:number;equity:number;cash?:number;unrealized?:number};
export function capitalGeometry(points:CapitalPoint[],initial:number,width:number,step:boolean){
 const left=76,right=Math.max(left+1,width-12),top=16,bottom=214;
 const values=points.map(p=>p.equity).concat(initial),min=Math.min(...values),max=Math.max(...values);
 const pad=Math.max((max-min)*.12,Math.abs(max)*.005,1),low=min-pad,high=max+pad;
 const start=points[0]?.time??0,end=points.at(-1)?.time??start;
 const x=(time:number)=>start===end?(left+right)/2:left+(time-start)/(end-start)*(right-left);
 const y=(value:number)=>bottom-(value-low)/(high-low)*(bottom-top);
 const path=points.map((p,i)=>`${i?(step?'H':'L'):'M'}${x(p.time)}${i&&step?'V':','}${y(p.equity)}`).join(' ');
 return {left,right,top,bottom,x,y,path,ticks:Array.from({length:4},(_,i)=>low+(high-low)*i/3)};
}
