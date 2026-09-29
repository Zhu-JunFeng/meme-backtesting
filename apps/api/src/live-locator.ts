import {fibLevels} from './fib.js';

export function liveFib(config:any,impulse:any,entryTime:number,exitTime:number|null,buyEvents:any[]){
 const unavailable=(reason:string)=>({status:'unavailable',reason});
 const i=impulse;
 if(!i||![i.low,i.high,i.lowTime,i.highTime,i.confirmedTime].every(Number.isFinite)||i.low<=0||i.high<=i.low||i.lowTime>=i.highTime||i.highTime>i.confirmedTime||i.confirmedTime>entryTime)
  return unavailable('入场时的 Fib 时间锚点不完整或确认晚于买入，无法可靠绘制');
 if(![i.lowIndex,i.highIndex,i.confirmedAtIndex].every((n:any)=>Number.isInteger(n)&&n>=0)||i.lowIndex>=i.highIndex||i.confirmedAtIndex<i.highIndex)
  return unavailable('入场时的 Fib 索引不完整，无法可靠绘制');
 return {status:'available',source:'实时入场决策快照',entryTime,exitTime,impulse:i,...fibLevels(config,i),
  low:{time:i.lowTime,value:i.low,index:i.lowIndex,synthetic:!!i.lowSynthetic},
  high:{time:i.highTime,value:i.high,index:i.highIndex,synthetic:!!i.highSynthetic},
  confirmed:{time:i.confirmedTime,index:i.confirmedAtIndex,synthetic:!!i.confirmedSynthetic},
  buys:buyEvents.map(o=>({label:o.label,time:Number(o.fill_time),value:Number(o.fill_value),ratio:(i.high-Number(o.fill_value))/(i.high-i.low)})),
  conditionGroup:config.entryConditionGroup};
}

export function decisionBucket(decisionTime:number,reason:string,step:number){
 // Entry/add/close-time exits are decided from the bar that just closed.
 const closeDecision=['entry','add','invalidation','timeout'].includes(reason);
 return Math.floor((decisionTime-(closeDecision?1:0))/step)*step;
}
