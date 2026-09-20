import type { BacktestConfig, BacktestReport, Candle, Condition, ConditionGroup, EquityPoint, Signal, SymbolRef, Trade } from '@meme/domain';
import { evaluateCondition, stopPrice, targetPrice, type Impulse } from './index.js';

export const ENGINE_VERSION = 'portfolio-3';
export const CHECKPOINT_VERSION = 2;
export const intervalMs = (interval: string) => ({'30s':30000,'1m':60000,'5m':300000,'15m':900000,'1h':3600000,'4h':14400000,'1d':86400000}[interval]!);
export const poolKey = (s: SymbolRef) => `${s.chain}:${s.ca}:${s.pairId}`;
export function validCandle(c: Candle) {
  return c.valid !== false && [c.time,c.open,c.high,c.low,c.close,c.volume].every(Number.isFinite) && c.low>0 && c.high>=Math.max(c.open,c.close) && c.low<=Math.min(c.open,c.close) && c.high>=c.low && c.volume>=0;
}
type Active = {trade:Trade;entryIndex:number;entries:number;impulse:Impulse};
type PoolState = {
  symbol:SymbolRef; index:number; history:Candle[]; offset:number; highPivots:number[]; lowPivots:number[];
  ema:Record<string,number>; previousEma:Record<string,number>; obv:number; obvs:number[];
  rolling:Record<string,{volume:number;previousVolume:number;gain:number;loss:number;rsi?:number;previousRsi?:number}>;
  active?:Active; traded:boolean; entryWasMet:boolean; addWasMet:boolean; lastPrice:number;
  closed:number; wins:number; net:number;
};
export interface EngineCheckpoint {
  version:number; engineVersion:string; states:PoolState[]; cash:number; peak:number; maxDrawdown:number; maxDrawdownPercent:number;
  processed:number; syntheticBars:number; invalidBars:number; lastTime:number|null; lastEquity:number;
  wins:number; losses:number; net:number; gross:number; grossProfit:number; grossLoss:number; holding:number; lossStreak:number; maxLossStreak:number;
}
export interface EngineBatch { trades:Trade[]; signals:Array<Signal & {symbol:SymbolRef}>; equity:EquityPoint[] }
export interface Tick {symbol:SymbolRef;candle:Candle;last:boolean}
function isGroup(c:Condition|ConditionGroup):c is ConditionGroup{return 'conditions' in c;}
function conditions(g:ConditionGroup):Condition[] {return g.enabled===false?[]:g.conditions.filter(c=>c.enabled!==false).flatMap(c=>isGroup(c)?conditions(c):[c]);}

/** All state needed to resume lives in s. Input readers own their independently checkpointed cursors. */
export class ResumableEngine {
  readonly s:EngineCheckpoint;
  private readonly byKey:Map<string,PoolState>;
  private readonly capacity:number;
  private readonly emaPeriods:number[];
  private readonly rollingPeriods:number[];
  private batch:EngineBatch={trades:[],signals:[],equity:[]};
  constructor(readonly config:BacktestConfig, checkpoint?:EngineCheckpoint) {
    if(checkpoint && (checkpoint.version!==CHECKPOINT_VERSION || checkpoint.engineVersion!==ENGINE_VERSION)) throw new Error('检查点版本不兼容，禁止从头自动重跑');
    const all=[...conditions(config.entryConditionGroup),...conditions(config.invalidationConditionGroup),...conditions(config.addConditionGroup ?? config.entryConditionGroup)];
    this.emaPeriods=[...new Set(all.filter(c=>c.type==='ema_reclaim').map(c=>Number(c.period)))];
    this.rollingPeriods=[...new Set(all.flatMap(c=>'period' in c && c.type!=='ema_reclaim'?[Number(c.period)]:[]))];
    const i=config.impulseCondition;
    this.capacity=Math.max(i.lookbackBars+i.leftBars+Math.max(5,i.leftBars*2)+3,...all.map(c=>Number('period' in c?c.period:'lookbackBars' in c?c.lookbackBars:0)+3),10);
    this.s=checkpoint?structuredClone(checkpoint):{
      version:CHECKPOINT_VERSION,engineVersion:ENGINE_VERSION,
      states:[...new Map(config.symbols.map(s=>[poolKey(s),s])).values()].sort((a,b)=>poolKey(a)<poolKey(b)?-1:1).map(symbol=>({symbol,index:-1,history:[],offset:0,highPivots:[],lowPivots:[],ema:{},previousEma:{},rolling:{},obv:0,obvs:[],traded:false,entryWasMet:false,addWasMet:false,lastPrice:0,closed:0,wins:0,net:0})),
      cash:config.executionConfig.initialCapital,peak:config.executionConfig.initialCapital,maxDrawdown:0,maxDrawdownPercent:0,processed:0,syntheticBars:0,invalidBars:0,lastTime:null,lastEquity:config.executionConfig.initialCapital,
      wins:0,losses:0,net:0,gross:0,grossProfit:0,grossLoss:0,holding:0,lossStreak:0,maxLossStreak:0
    };
    this.byKey=new Map(this.s.states.map(s=>[poolKey(s.symbol),s]));
  }
  checkpoint():EngineCheckpoint {return structuredClone(this.s);}
  get bufferedRows(){return this.batch.trades.length+this.batch.signals.length+this.batch.equity.length;}
  drain():EngineBatch {const b=this.batch;this.batch={trades:[],signals:[],equity:[]};return b;}
  private update(s:PoolState,c:Candle) {
    const previous=s.history.at(-1);
    s.index++;s.history.push(c);s.lastPrice=c.close;
    for(const period of this.emaPeriods) {const old=s.ema[period];s.previousEma[period]=old ?? c.close;const k=2/(period+1);s.ema[period]=old===undefined?c.close:c.close*k+old*(1-k);}
    for(const period of this.rollingPeriods){
      const m=s.rolling[period] ||= {volume:0,previousVolume:0,gain:0,loss:0};m.previousVolume=m.volume;m.previousRsi=m.rsi;
      m.volume+=c.volume;if(s.index>=period)m.volume-=s.history[s.index-period-s.offset].volume;
      if(previous){const d=c.close-previous.close;m.gain+=Math.max(0,d);m.loss+=Math.max(0,-d);}
      if(s.index>period){const d=s.history[s.index-period-s.offset].close-s.history[s.index-period-1-s.offset].close;m.gain-=Math.max(0,d);m.loss-=Math.max(0,-d);}
      // Periodically rebase sums, bounding floating point drift without scanning full history.
      if(s.index%256===0){m.volume=0;m.gain=0;m.loss=0;for(let j=Math.max(0,s.index-period+1);j<=s.index;j++){const b=s.history[j-s.offset];m.volume+=b.volume;if(j>0){const d=b.close-s.history[j-1-s.offset].close;m.gain+=Math.max(0,d);m.loss+=Math.max(0,-d);}}}
      if(s.index>=period)m.rsi=m.loss<=Number.EPSILON?100:100-100/(1+m.gain/m.loss);
    }
    s.obv+=previous?(c.close>previous.close?c.volume:c.close<previous.close?-c.volume:0):0;s.obvs.push(s.obv);
    if(s.history.length>this.capacity){s.history.shift();s.obvs.shift();s.offset++;}
    const cfg=this.config.impulseCondition,p=s.index-cfg.rightBars,local=p-s.offset;
    if(p>=cfg.leftBars && local>=cfg.leftBars) {
      const pivot=s.history[local];let low=true,high=true;
      for(let j=local-cfg.leftBars;j<=local+cfg.rightBars;j++){low &&= pivot.low<=s.history[j].low;high &&=pivot.high>=s.history[j].high;}
      if(low)s.lowPivots.push(p);if(high)s.highPivots.push(p);
    }
    const first=Math.max(cfg.leftBars,s.index+1-cfg.lookbackBars);
    while(s.lowPivots.length && s.lowPivots[0]<first)s.lowPivots.shift();
    while(s.highPivots.length && s.highPivots[0]<first)s.highPivots.shift();
  }
  private impulse(s:PoolState):Impulse|undefined {
    const cfg=this.config.impulseCondition;
    if(cfg.enabled===false || s.index+1<cfg.leftBars+cfg.rightBars+2)return;
    let lowest=Infinity;for(const lo of s.lowPivots)lowest=Math.min(lowest,s.history[lo-s.offset].low);
    for(let h=s.highPivots.length-1;h>=0;h--){
     // A flat synthetic gap can have hundreds of tied pivots: reject an impossible high before pair search.
     if((s.history[s.highPivots[h]-s.offset].high/lowest-1)*100<cfg.minGainPercent)continue;
     for(let l=s.lowPivots.length-1;l>=0;l--){
      const hi=s.highPivots[h],lo=s.lowPivots[l];if(lo>=hi)continue;if(hi-lo>cfg.maxDurationBars)break;
      const low=s.history[lo-s.offset].low,high=s.history[hi-s.offset].high,gainPercent=(high/low-1)*100;
      if(gainPercent<cfg.minGainPercent)continue;
      // Bounded sums retain the exact left-to-right floating-point arithmetic of the reference engine.
      let volume=0;for(let j=lo;j<=hi;j++)volume+=s.history[j-s.offset].volume;
      const averageVolume=volume/(hi-lo+1);
      if(cfg.requireVolumeExpansion){const begin=Math.max(0,lo-Math.max(5,cfg.leftBars*2));let baseline=0;for(let j=begin;j<lo;j++)baseline+=s.history[j-s.offset].volume;if(lo===begin || averageVolume<baseline/(lo-begin)*(cfg.volumeExpansionRatio ?? 1.5))continue;}
      return {low,high,lowIndex:lo,highIndex:hi,confirmedAtIndex:hi+cfg.rightBars,gainPercent,averageVolume};
     }
    }
  }
  private group(group:ConditionGroup,s:PoolState,impulse?:Impulse):boolean {
    if(group.enabled===false)return false;
    const active=group.conditions.filter(c=>c.enabled!==false);if(!active.length)return false;
    const relative=impulse?{...impulse,lowIndex:impulse.lowIndex-s.offset,highIndex:impulse.highIndex-s.offset,confirmedAtIndex:impulse.confirmedAtIndex-s.offset}:undefined;
    const results=active.map(c=>{
      if(isGroup(c))return this.group(c,s,impulse);
      if(c.type==='ema_reclaim')return s.history.length>=2 && s.history.at(-2)!.close<=s.previousEma[c.period] && s.history.at(-1)!.close>s.ema[c.period];
      if(c.type==='rsi_recovery'){
        const m=s.rolling[c.period];if(m.previousRsi===undefined || m.rsi===undefined)return false;
        if(Math.abs(m.previousRsi-c.oversold)<1e-8 || Math.abs(m.rsi-c.recovery)<1e-8)return evaluateCondition(c,s.history,relative);
        return m.previousRsi<=c.oversold && m.rsi>=c.recovery;
      }
      if(c.type==='bullish_volume_confirmation' || c.type==='bearish_volume_invalidation'){
        if(!s.index)return false;const b=s.history.at(-1)!,m=s.rolling[c.period],threshold=m.previousVolume/Math.min(c.period,s.index)*c.minRatio;
        if(Math.abs(b.volume-threshold)<1e-10*Math.max(1,Math.abs(b.volume),Math.abs(threshold)))return evaluateCondition(c,s.history,relative);
        return b.volume>=threshold && (c.type==='bullish_volume_confirmation'?b.close>b.open:b.close<b.open && (b.open-b.close)/b.open*100>=c.minBodyPercent);
      }
      if(c.type==='volume_contraction' && impulse && impulse.highIndex<s.index-c.period+1){
        if(impulse.averageVolume<=0)return false;const ratio=s.rolling[c.period].volume/Math.min(c.period,s.index+1)/impulse.averageVolume;
        if(Math.abs(ratio-c.maxRatio)<1e-8)return evaluateCondition(c,s.history,relative);return ratio<=c.maxRatio;
      }
      if(c.type==='obv_confirmation'){if(s.index<c.lookbackBars)return false;const before=s.obvs[s.obvs.length-1-c.lookbackBars];const volume=s.history.slice(-c.lookbackBars).reduce((v,b)=>v+b.volume,0);return volume>0 && (s.obv-before)/volume*100>=c.minChangePercent;}
      return evaluateCondition(c,s.history,relative);
    });
    return group.mode==='all'?results.every(Boolean):group.mode==='any'?results.some(Boolean):results.filter(Boolean).length>=Math.max(1,group.minMatches ?? 1);
  }
  private enter(s:PoolState,c:Candle,impulse:Impulse) {
    const existing=s.active,cfg=this.config,cost=cfg.executionConfig,sizing=cfg.positionConfig.sizing;
    const stop=existing?stopPrice(cfg,existing):c.close*.9;
    const amount=sizing.type==='fixed_amount'?sizing.value:sizing.type==='fixed_percent'?this.s.cash*sizing.value/100:Math.min(this.s.cash,this.s.cash*sizing.value/100*c.close/Math.max(Number.EPSILON,c.close-stop));
    const value=Math.max(0,Math.min(this.s.cash/(1+(cost.feePercent+cost.slippagePercent+cost.buyTaxPercent)/100),amount));if(!value)return;
    const quantity=value/c.close,fee=value*cost.feePercent/100,slip=value*cost.slippagePercent/100,tax=value*cost.buyTaxPercent/100;
    this.s.cash-=value+fee+slip+tax;
    if(existing){const t=existing.trade;t.entryPrice=(t.entryPrice*t.quantity+value)/(t.quantity+quantity);t.quantity+=quantity;t.fees+=fee;t.slippageCost+=slip;t.taxCost+=tax;existing.entries++;
      const signal:Signal={time:c.time,price:c.close,type:'add',quantity,reason:{conditionGroup:cfg.addConditionGroup ?? cfg.entryConditionGroup}};t.adds.push(signal);this.batch.signals.push({symbol:s.symbol,...signal});
    }else{const trade:Trade={symbol:s.symbol,entryTime:c.time,entryPrice:c.close,quantity,fees:fee,slippageCost:slip,taxCost:tax,adds:[]};s.active={trade,entryIndex:s.index,entries:1,impulse};this.batch.signals.push({symbol:s.symbol,time:c.time,price:c.close,type:'entry',quantity,reason:{impulse,conditionGroup:cfg.entryConditionGroup}});}
  }
  private close(s:PoolState,c:Candle,price:number,type:Signal['type'],reason:Record<string,unknown>) {
    if(!s.active)return;const a=s.active,t=a.trade,cost=this.config.executionConfig,proceeds=t.quantity*price;
    const fee=proceeds*cost.feePercent/100,slip=proceeds*cost.slippagePercent/100,tax=proceeds*cost.sellTaxPercent/100;
    t.fees+=fee;t.slippageCost+=slip;t.taxCost+=tax;t.exitTime=c.time;t.exitPrice=price;t.grossPnl=(price-t.entryPrice)*t.quantity;t.netPnl=t.grossPnl-t.fees-t.slippageCost-t.taxCost;t.exitReason=type;t.holdingBars=s.index-a.entryIndex;
    this.s.cash+=proceeds-fee-slip-tax;this.batch.signals.push({symbol:s.symbol,time:c.time,price,type,quantity:t.quantity,reason});this.batch.trades.push(t);
    s.closed++;s.net+=t.netPnl;this.s.net+=t.netPnl;this.s.gross+=t.grossPnl;this.s.holding+=t.holdingBars;
    if(t.netPnl>0){s.wins++;this.s.wins++;this.s.grossProfit+=t.netPnl;this.s.lossStreak=0;}else{this.s.losses++;this.s.grossLoss-=t.netPnl;this.s.lossStreak++;this.s.maxLossStreak=Math.max(this.s.maxLossStreak,this.s.lossStreak);}
    s.active=undefined;s.traded=true;s.entryWasMet=true;
  }
  /** Caller supplies every pool at this timestamp; never checkpoint in the middle of this method. */
  step(ticks:Tick[]) {
    if(!ticks.length)return;
    const ordered=[...ticks].sort((a,b)=>poolKey(a.symbol)<poolKey(b.symbol)?-1:1),time=ordered[0].candle.time;
    if(ordered.some(t=>t.candle.time!==time) || (this.s.lastTime!==null && time<=this.s.lastTime))throw new Error('时间批次必须完整且严格递增');
    const contexts=ordered.map(t=>{const s=this.byKey.get(poolKey(t.symbol));if(!s)throw new Error('未知交易池');this.update(s,t.candle);if(t.candle.synthetic)this.s.syntheticBars++;return {...t,s};});
    for(const {s,candle:c,last} of contexts){if(!s.active)continue;const stop=stopPrice(this.config,s.active),target=targetPrice(this.config,s.active,stop);let exit:{price:number;type:Signal['type']}|undefined;
      if(c.open<=stop || c.low<=stop)exit={price:c.open<=stop?c.open:stop,type:'stop_loss'};
      else if(this.group(this.config.invalidationConditionGroup,s,s.active.impulse))exit={price:c.close,type:'invalidation'};
      else if(target>s.active.trade.entryPrice && (c.open>=target || c.high>=target))exit={price:c.open>=target?c.open:target,type:'take_profit'};
      else if(this.config.exitConfig.maxHoldingBars && s.index-s.active.entryIndex>=this.config.exitConfig.maxHoldingBars)exit={price:c.close,type:'timeout'};
      else if(last && this.config.exitConfig.closeAtEnd)exit={price:c.close,type:'end_of_backtest'};
      if(exit)this.close(s,c,exit.price,exit.type,{priority:exit.type,stop,target});
    }
    let positions=this.s.states.filter(s=>s.active).length;
    for(const {s,candle:c,last} of contexts){
      if(s.active){const add=this.group(this.config.addConditionGroup ?? this.config.entryConditionGroup,s,s.active.impulse);if(this.config.positionConfig.mode==='pyramiding' && s.active.entries<this.config.positionConfig.maxEntries && add && !s.addWasMet)this.enter(s,c,s.active.impulse);s.addWasMet=add;}
      else{const impulse=this.impulse(s),entry=!!impulse && this.group(this.config.entryConditionGroup,s,impulse);if(entry && !s.entryWasMet && (this.config.positionConfig.allowReentry || !s.traded) && positions<this.config.positionConfig.maxConcurrentPositions){this.enter(s,c,impulse!);if(s.active)positions++;}s.entryWasMet=entry;s.addWasMet=false;}
      if(last && this.config.exitConfig.closeAtEnd && s.active){this.close(s,c,c.close,'end_of_backtest',{closeAtEnd:true});positions--;}
      this.s.processed++;
    }
    let open=0,unrealized=0;for(const s of this.s.states)if(s.active){const t=s.active.trade;open+=s.lastPrice*t.quantity;unrealized+=(s.lastPrice-t.entryPrice)*t.quantity;}
    const equity=this.s.cash+open;this.s.peak=Math.max(this.s.peak,equity);this.s.maxDrawdown=Math.max(this.s.maxDrawdown,this.s.peak-equity);this.s.maxDrawdownPercent=Math.max(this.s.maxDrawdownPercent,this.s.peak?(this.s.peak-equity)/this.s.peak*100:0);this.s.lastTime=time;this.s.lastEquity=equity;this.batch.equity.push({time,equity,cash:this.s.cash,unrealized});
  }
  finalizeOpenPositions() {
    for(const s of this.s.states)if(s.active){this.batch.trades.push(s.active.trade);this.batch.signals.push({symbol:s.symbol,time:s.history.at(-1)!.time,price:s.lastPrice,type:'risk_event',quantity:s.active.trade.quantity,reason:{message:'数据结束时仍持仓，浮动盈亏不含未来卖出成本'}});}
  }
  finish():BacktestReport {
    const openPositions=this.s.states.filter(s=>s.active).map(s=>{const t=s.active!.trade,fees=t.fees+t.slippageCost+t.taxCost;return {symbol:s.symbol,quantity:t.quantity,lastPrice:s.lastPrice,fees,netPnl:(s.lastPrice-t.entryPrice)*t.quantity-fees};});
    const n=this.s.wins+this.s.losses,u=openPositions.reduce((v,p)=>v+p.netPnl,0);
    return {engineVersion:ENGINE_VERSION,openPositions,unrealizedPnl:u,totalNetPnl:this.s.net+u,finalEquity:this.s.lastEquity,totalTrades:n,wins:this.s.wins,losses:this.s.losses,winRate:n?this.s.wins/n:0,grossPnl:this.s.gross,netPnl:this.s.net,returnPercent:(this.s.net+u)/this.config.executionConfig.initialCapital*100,profitFactor:this.s.grossLoss?this.s.grossProfit/this.s.grossLoss:this.s.grossProfit?Infinity:0,maxDrawdown:this.s.maxDrawdown,maxDrawdownPercent:this.s.maxDrawdownPercent,maxConsecutiveLosses:this.s.maxLossStreak,averageHoldingBars:n?this.s.holding/n:0,dataQuality:{syntheticBars:this.s.syntheticBars,invalidBars:this.s.invalidBars,riskEvents:openPositions.length},bySymbol:this.s.states.map(s=>({symbol:s.symbol,trades:s.closed,netPnl:s.net,winRate:s.closed?s.wins/s.closed:0}))};
  }
}
