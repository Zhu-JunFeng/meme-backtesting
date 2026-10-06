import type { Candle, ConditionGroup, StrategyConfig, SymbolRef } from '@meme/domain';
import { detectImpulse, evaluateConditionGroup, stopPrice, targetPrice, type Impulse } from './index.js';
import { matchBarExit } from './bar-exit.js';

export interface MarketTrade { id:string; chain:string; ca:string; pairId:string; time:number; price:number; mcap?:number; volumeUsd:number }
export interface ClosedMarketBar { symbol:SymbolRef; interval:'30s'|'1m'; type:'price'|'mcap'; candle:Candle; tradeCount:number; closeTradeId?:string; closeTradeTime?:number }
type Bucket = {symbol:SymbolRef;interval:'30s'|'1m';type:'price'|'mcap';candle:Candle;firstAt:number;lastAt:number;firstId:string;lastId:string;tradeCount:number};
export type TradeAcceptance={accepted:boolean;late:boolean;reason?:'invalid'|'duplicate'|'too_old'|'closed'};
const period = (interval:'30s'|'1m') => interval==='30s'?30_000:60_000;
export class LiveCandleAggregator {
  private buckets=new Map<string,Bucket>();
  private finalized=new Map<string,number>();
  private seen=new Map<string,number>();
  private lastTradeTime=new Map<string,number>();
  private lastBars=new Map<string,ClosedMarketBar>();
  constructor(private readonly onClose:(bar:ClosedMarketBar)=>void){}
  /** Recovery baseline only; never emitted or inserted as an observed candle. */
  seed(bar:ClosedMarketBar){
    const key=`${bar.symbol.chain}:${bar.symbol.ca}:${bar.symbol.pairId}:${bar.interval}:${bar.type}`;
    if((this.lastBars.get(key)?.candle.time??-1)<bar.candle.time)this.lastBars.set(key,bar);
  }
  accept(trade:MarketTrade){return this.acceptDetailed(trade).accepted;}
  acceptDetailed(trade:MarketTrade):TradeAcceptance{
    if(!trade.id || !trade.chain || !trade.ca || !trade.pairId || !Number.isSafeInteger(trade.time) || trade.time<0 || !Number.isFinite(trade.price) || trade.price<=0 || !Number.isFinite(trade.volumeUsd) || trade.volumeUsd<0)return {accepted:false,late:false,reason:'invalid'};
    const identity=`${trade.chain}:${trade.pairId}:${trade.id}`;
    if(this.seen.has(identity))return {accepted:false,late:false,reason:'duplicate'};
    const marketKey=`${trade.chain}:${trade.pairId}`;
    const latest=this.lastTradeTime.get(marketKey)??-1,late=trade.time<latest;
    const sameMinute=Math.floor(trade.time/60_000)===Math.floor(latest/60_000);
    if(late && latest-trade.time>=30_000 && !sameMinute)return {accepted:false,late:true,reason:'too_old'};
    this.lastTradeTime.set(marketKey,Math.max(latest,trade.time));
    this.seen.set(identity,trade.time);
    if(this.seen.size>50_000)for(const [key,time] of this.seen)if(time<Math.max(latest,trade.time)-300_000)this.seen.delete(key);
    while(this.seen.size>100_000)this.seen.delete(this.seen.keys().next().value!);
    const symbol={chain:trade.chain,ca:trade.ca,pairId:trade.pairId};
    let accepted=false;
    for(const interval of ['30s','1m'] as const)for(const type of ['price','mcap'] as const){
      const value=type==='price'?trade.price:trade.mcap;
      if(value===undefined || !Number.isFinite(value) || value<=0)continue;
      const start=Math.floor(trade.time/period(interval))*period(interval),key=`${trade.chain}:${trade.ca}:${trade.pairId}:${interval}:${type}`;
      if(start<=(this.finalized.get(key)??-1))continue;
      const prior=this.buckets.get(key);
      if(prior && prior.candle.time<start){this.finish(key,prior);}
      const current=this.buckets.get(key);
      if(current && current.candle.time===start){
        accepted=true;
        current.candle.high=Math.max(current.candle.high,value);current.candle.low=Math.min(current.candle.low,value);
        if(trade.time<current.firstAt || (trade.time===current.firstAt&&trade.id<current.firstId)){current.firstAt=trade.time;current.firstId=trade.id;current.candle.open=value;}
        if(trade.time>current.lastAt || (trade.time===current.lastAt&&trade.id>current.lastId)){current.lastAt=trade.time;current.lastId=trade.id;current.candle.close=value;}
        current.candle.volume+=trade.volumeUsd;current.tradeCount++;
      }else if(!current || current.candle.time<start){accepted=true;this.buckets.set(key,{symbol,interval,type,candle:{time:start,closeTime:start+period(interval),open:value,high:value,low:value,close:value,volume:trade.volumeUsd,valid:true},firstAt:trade.time,lastAt:trade.time,firstId:trade.id,lastId:trade.id,tradeCount:1});}
    }
    return {accepted,late,reason:accepted?undefined:'closed'};
  }
  flush(now:number,canFill?:(bar:ClosedMarketBar,time:number)=>boolean){
    // Fill gaps before closing a later real bucket, then the trailing idle buckets.
    if(canFill)for(const [key,bar] of this.lastBars)this.fillUntil(key,bar,Math.min(now,this.buckets.get(key)?.candle.time??now),canFill);
    for(const [key,bucket] of this.buckets)if(bucket.candle.closeTime<=now)this.finish(key,bucket);
    if(canFill)for(const [key,bar] of this.lastBars)this.fillUntil(key,bar,now,canFill);
  }
  private fillUntil(key:string,bar:ClosedMarketBar,now:number,canFill:(bar:ClosedMarketBar,time:number)=>boolean){
    const step=period(bar.interval);
    for(let time=bar.candle.closeTime;time+step<=now;time+=step){
      if(!canFill(bar,time))break;
      const value=bar.candle.close,candle={time,closeTime:time+step,open:value,high:value,low:value,close:value,volume:0,valid:true,synthetic:true};
      const next={...bar,candle,tradeCount:0};this.lastBars.set(key,next);this.finalized.set(key,time);this.onClose(next);
    }
  }
  markClosedThrough(chain:string,ca:string,pairId:string,now:number){
    for(const interval of ['30s','1m'] as const)for(const type of ['price','mcap'] as const){
      const key=`${chain}:${ca}:${pairId}:${interval}:${type}`,lastClosed=Math.floor(now/period(interval))*period(interval)-period(interval);
      this.finalized.set(key,Math.max(this.finalized.get(key)??-1,lastClosed));
      const bucket=this.buckets.get(key);if(bucket&&bucket.candle.time<=lastClosed)this.buckets.delete(key);
    }
  }
  discardPair(chain:string,pairId:string){
    for(const [key,bucket] of this.buckets)if(bucket.symbol.chain===chain&&bucket.symbol.pairId===pairId)this.buckets.delete(key);
    for(const [key,bar] of this.lastBars)if(bar.symbol.chain===chain&&bar.symbol.pairId===pairId)this.lastBars.delete(key);
  }
  private finish(key:string,bucket:Bucket){this.buckets.delete(key);this.finalized.set(key,bucket.candle.time);const bar={symbol:bucket.symbol,interval:bucket.interval,type:bucket.type,candle:{...bucket.candle},tradeCount:bucket.tradeCount,closeTradeId:bucket.lastId,closeTradeTime:bucket.lastAt};this.lastBars.set(key,bar);this.onClose(bar);}
}

export interface LivePosition {entryPrice:number;quantity:number;entries:number;entryTime:number;entryBar:number;impulse:Impulse;lockPrice?:number;lockTier?:number;tradeNo:number;costBasisUsd?:number;positionId?:string}
export interface LiveDecision {side:'buy'|'sell';reason:'entry'|'add'|'stop_loss'|'profit_lock'|'take_profit'|'invalidation'|'timeout';time:number;value:number;impulse?:Impulse; stop?:number; target?:number}
export interface LiveEvaluatorState {history:Candle[];position?:LivePosition;lastEntryMatch:boolean;lastAddMatch:boolean;trades:number;lastCandleTime?:number;lastTokenPrice?:number}
function maxWindow(config:StrategyConfig){return Math.max(512,config.impulseCondition.lookbackBars+config.impulseCondition.leftBars+config.impulseCondition.rightBars+8);}
export class LiveEvaluator {
 readonly state:LiveEvaluatorState;
 constructor(readonly config:StrategyConfig, readonly signalTime:number, state?:LiveEvaluatorState){this.state=state?structuredClone(state):{history:[],lastEntryMatch:false,lastAddMatch:false,trades:0};}
 onClosedCandle(candle:Candle,warmup=false):LiveDecision|undefined{
  const s=this.state;if(s.lastCandleTime!==undefined && candle.time<=s.lastCandleTime)return;
  s.lastCandleTime=candle.time;s.history.push(candle);
  if(s.history.length>maxWindow(this.config)){
   s.history.shift();
   if(s.position){s.position.entryBar--;s.position.impulse.lowIndex--;s.position.impulse.highIndex--;s.position.impulse.confirmedAtIndex--;}
  }
  if(warmup)return;
  const position=s.position,eligible=this.config.entryAfterSignal===false||candle.time>this.signalTime;
  let decision:LiveDecision|undefined;
  if(position){
    const impulse=position.impulse,active={trade:{entryPrice:position.entryPrice} as never,impulse} as never;
    const config=this.config as Parameters<typeof stopPrice>[0],base=stopPrice(config,active),target=targetPrice(config,active,base);
    const exit=matchBarExit(candle,{entry:position.entryPrice,baseStop:base,lockPrice:position.lockPrice,target,
      invalid:()=>evaluateConditionGroup(this.config.invalidationConditionGroup,s.history,impulse),
      timedOut:!!this.config.exitConfig.maxHoldingBars && s.history.length-1-position.entryBar>=this.config.exitConfig.maxHoldingBars});
    if(exit && exit.type!=='end_of_backtest')decision={side:'sell',reason:exit.type,time:candle.closeTime,value:exit.price,stop:Math.max(base,position.lockPrice??-Infinity),target};
    else if(eligible && this.config.positionConfig.mode==='pyramiding' && position.entries<this.config.positionConfig.maxEntries){
      const matches=evaluateConditionGroup(this.config.addConditionGroup??this.config.entryConditionGroup,s.history,impulse);
      if(matches && !s.lastAddMatch)decision={side:'buy',reason:'add',time:candle.closeTime,value:candle.close,impulse};
      s.lastAddMatch=matches;
    }
  }else if(eligible){
    s.lastAddMatch=false;
    const impulse=detectImpulse(s.history,this.config.impulseCondition);
    const matches=!!impulse && evaluateConditionGroup(this.config.entryConditionGroup,s.history,impulse);
    if(matches && !s.lastEntryMatch && (this.config.positionConfig.allowReentry || s.trades===0))decision={side:'buy',reason:'entry',time:candle.closeTime,value:candle.close,impulse};
    s.lastEntryMatch=matches;
  }
  return decision;
 }
 confirmClose(candle:Candle){
  const position=this.state.position;
  if(position && this.config.exitConfig.profitLock?.enabled)this.config.exitConfig.profitLock.tiers.forEach((tier,index)=>{
    if((position.lockTier??-1)>=index || candle.close<position.entryPrice*(1+tier.activationPercent/100))return;
    position.lockTier=index;position.lockPrice=Math.max(position.lockPrice??-Infinity,position.entryPrice*(1+tier.floorPercent/100));
  });
 }
 snapshot(){return structuredClone(this.state);}
}
