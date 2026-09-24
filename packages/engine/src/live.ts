import type { Candle, ConditionGroup, StrategyConfig, SymbolRef } from '@meme/domain';
import { detectImpulse, evaluateConditionGroup, stopPrice, targetPrice, type Impulse } from './index.js';

export interface MarketTrade { id:string; chain:string; ca:string; pairId:string; time:number; price:number; mcap?:number; volumeUsd:number }
export interface ClosedMarketBar { symbol:SymbolRef; interval:'30s'|'1m'; type:'price'|'mcap'; candle:Candle; tradeCount:number }
type Bucket = {symbol:SymbolRef;interval:'30s'|'1m';type:'price'|'mcap';candle:Candle;firstAt:number;lastAt:number;tradeCount:number};
const period = (interval:'30s'|'1m') => interval==='30s'?30_000:60_000;
export class LiveCandleAggregator {
  private buckets=new Map<string,Bucket>();
  private finalized=new Map<string,number>();
  private seen=new Map<string,number>();
  private lastTradeTime=new Map<string,number>();
  constructor(private readonly onClose:(bar:ClosedMarketBar)=>void){}
  accept(trade:MarketTrade){
    if(!trade.id || !trade.chain || !trade.ca || !trade.pairId || !Number.isSafeInteger(trade.time) || trade.time<0 || !Number.isFinite(trade.price) || trade.price<=0 || !Number.isFinite(trade.volumeUsd) || trade.volumeUsd<0)return false;
    const identity=`${trade.chain}:${trade.pairId}:${trade.id}`;
    if(this.seen.has(identity))return false;
    const marketKey=`${trade.chain}:${trade.pairId}`;
    // Out-of-order ticks must never execute an order after a newer market event.
    if(trade.time<(this.lastTradeTime.get(marketKey)??-1))return false;
    const priceBucket=`${trade.chain}:${trade.ca}:${trade.pairId}:30s:price`;
    if(Math.floor(trade.time/30_000)*30_000<=(this.finalized.get(priceBucket)??-1))return false;
    this.lastTradeTime.set(marketKey,trade.time);
    this.seen.set(identity,trade.time);
    if(this.seen.size>50_000)for(const [key,time] of this.seen)if(time<trade.time-300_000)this.seen.delete(key);
    const symbol={chain:trade.chain,ca:trade.ca,pairId:trade.pairId};
    for(const interval of ['30s','1m'] as const)for(const type of ['price','mcap'] as const){
      const value=type==='price'?trade.price:trade.mcap;
      if(value===undefined || !Number.isFinite(value) || value<=0)continue;
      const start=Math.floor(trade.time/period(interval))*period(interval),key=`${trade.chain}:${trade.ca}:${trade.pairId}:${interval}:${type}`;
      if(start<=(this.finalized.get(key)??-1))continue;
      const prior=this.buckets.get(key);
      if(prior && prior.candle.time<start){this.finish(key,prior);}
      const current=this.buckets.get(key);
      if(current && current.candle.time===start){
        current.candle.high=Math.max(current.candle.high,value);current.candle.low=Math.min(current.candle.low,value);
        if(trade.time<current.firstAt){current.firstAt=trade.time;current.candle.open=value;}
        if(trade.time>=current.lastAt){current.lastAt=trade.time;current.candle.close=value;}
        current.candle.volume+=trade.volumeUsd;current.tradeCount++;
      }else if(!current || current.candle.time<start){this.buckets.set(key,{symbol,interval,type,candle:{time:start,closeTime:start+period(interval),open:value,high:value,low:value,close:value,volume:trade.volumeUsd,valid:true},firstAt:trade.time,lastAt:trade.time,tradeCount:1});}
    }
    return true;
  }
  flush(now:number){for(const [key,bucket] of this.buckets)if(bucket.candle.closeTime<=now)this.finish(key,bucket);}
  discardPair(chain:string,pairId:string){
    for(const [key,bucket] of this.buckets)if(bucket.symbol.chain===chain&&bucket.symbol.pairId===pairId)this.buckets.delete(key);
    this.lastTradeTime.delete(`${chain}:${pairId}`);
  }
  private finish(key:string,bucket:Bucket){this.buckets.delete(key);this.finalized.set(key,bucket.candle.time);this.onClose({symbol:bucket.symbol,interval:bucket.interval,type:bucket.type,candle:{...bucket.candle},tradeCount:bucket.tradeCount});}
}

export interface LivePosition {entryPrice:number;quantity:number;entries:number;entryTime:number;entryBar:number;impulse:Impulse;lockPrice?:number;lockTier?:number;tradeNo:number;costBasisUsd?:number}
export interface LiveDecision {side:'buy'|'sell';reason:'entry'|'add'|'stop_loss'|'profit_lock'|'take_profit'|'invalidation'|'timeout';time:number;value:number;impulse?:Impulse}
export interface LiveEvaluatorState {history:Candle[];position?:LivePosition;lastEntryMatch:boolean;lastAddMatch:boolean;trades:number;lastCandleTime?:number;lastTokenPrice?:number}
function maxWindow(config:StrategyConfig){return Math.max(512,config.impulseCondition.lookbackBars+config.impulseCondition.leftBars+config.impulseCondition.rightBars+8);}
export class LiveEvaluator {
 readonly state:LiveEvaluatorState;
 constructor(readonly config:StrategyConfig, readonly signalTime:number, state?:LiveEvaluatorState){this.state=state?structuredClone(state):{history:[],lastEntryMatch:false,lastAddMatch:false,trades:0};}
 onClosedCandle(candle:Candle):LiveDecision|undefined{
  const s=this.state;if(s.lastCandleTime!==undefined && candle.time<=s.lastCandleTime)return;
  s.lastCandleTime=candle.time;s.history.push(candle);
  if(s.history.length>maxWindow(this.config)){
   s.history.shift();
   if(s.position){s.position.entryBar--;s.position.impulse.lowIndex--;s.position.impulse.highIndex--;s.position.impulse.confirmedAtIndex--;}
  }
  const position=s.position,eligible=candle.time>this.signalTime;
  let decision:LiveDecision|undefined;
  if(position){
    const impulse=position.impulse,invalid=evaluateConditionGroup(this.config.invalidationConditionGroup,s.history,impulse);
    if(invalid)decision={side:'sell',reason:'invalidation',time:candle.closeTime,value:candle.close};
    else if(this.config.exitConfig.maxHoldingBars && s.history.length-position.entryBar>=this.config.exitConfig.maxHoldingBars)decision={side:'sell',reason:'timeout',time:candle.closeTime,value:candle.close};
    else if(eligible && this.config.positionConfig.mode==='pyramiding' && position.entries<this.config.positionConfig.maxEntries){
      const matches=evaluateConditionGroup(this.config.addConditionGroup??this.config.entryConditionGroup,s.history,impulse);
      if(matches && !s.lastAddMatch)decision={side:'buy',reason:'add',time:candle.closeTime,value:candle.close,impulse};
      s.lastAddMatch=matches;
    }
    if(this.config.exitConfig.profitLock?.enabled){
      this.config.exitConfig.profitLock.tiers.forEach((tier,index)=>{if((position.lockTier??-1)>=index || candle.close<position.entryPrice*(1+tier.activationPercent/100))return;
        position.lockTier=index;position.lockPrice=Math.max(position.lockPrice??-Infinity,position.entryPrice*(1+tier.floorPercent/100));});
    }
  }else if(eligible){
    const impulse=detectImpulse(s.history,this.config.impulseCondition);
    const matches=!!impulse && evaluateConditionGroup(this.config.entryConditionGroup,s.history,impulse);
    if(matches && !s.lastEntryMatch && (this.config.positionConfig.allowReentry || s.trades===0))decision={side:'buy',reason:'entry',time:candle.closeTime,value:candle.close,impulse};
    s.lastEntryMatch=matches;
  }
  return decision;
 }
 onTrade(trade:MarketTrade,valueType:'price'|'mcap'):LiveDecision|undefined{
  const p=this.state.position,value=valueType==='price'?trade.price:trade.mcap;
  if(!p || !value || !Number.isFinite(value) || trade.time<=p.entryTime)return;
  const config={...this.config} as Parameters<typeof stopPrice>[0],base=stopPrice(config,{trade:{entryPrice:p.entryPrice} as never,impulse:p.impulse} as never);
  const stop=Math.max(base,p.lockPrice??-Infinity),target=targetPrice(config,{trade:{entryPrice:p.entryPrice} as never,impulse:p.impulse} as never,base);
  if(value<=stop)return {side:'sell',reason:(p.lockPrice??-Infinity)>base?'profit_lock':'stop_loss',time:trade.time,value};
  if(target>p.entryPrice && value>=target)return {side:'sell',reason:'take_profit',time:trade.time,value};
 }
 snapshot(){return structuredClone(this.state);}
}
