import {stopPrice,targetPrice} from '@meme/engine';
import type {StrategyConfig} from '@meme/domain';

type FillOrder={id:string;position_id?:string|null;chain:string;ca:string;pair_id:string;side:'buy'|'sell';reason:string;decision_time?:string|number;fill_time:string|number;fill_value:string|number;fill_price:string|number;market_cap:string|number|null;quantity:string|number;gross_amount:string|number;fee:string|number;slippage_cost:string|number;tax_cost:string|number};
type Watch={chain:string;ca:string;last_trade_at:string|null;state_json:any};
export type LiveCycle={id:string;chain:string;ca:string;pairId:string;pairIds:string[];orderIds:string[];tradeNo:number;buyTime:number;buyReason:string;buyAmount:number;buyCost:number;buyQuantity:number;buyValue:number|null;buyMarketCap:number|null;entryCount:number;sellTime:number|null;sellReason:string|null;sellValue:number|null;sellMarketCap:number|null;sellAmount:number;sellQuantity:number;realizedPnl:number;quantity:number;remainingCost:number;status:'open'|'closed'|'incomplete';unrealizedPnl:number|null;valuationTime:number|null;takeProfitValue:number|null;stopLossValue:number|null;exitLevelReason:string|null};
const num=(value:unknown)=>{const n=Number(value);return Number.isFinite(n)?n:NaN;};
const finitePositive=(value:unknown)=>Number.isFinite(num(value))&&num(value)>0;
const dateMs=(value:string|null)=>value?new Date(value).getTime():NaN;
const key=(chain:string,ca:string)=>`${chain}:${ca}`;

/** Reconstructs only attributable filled position cycles. Old fills without position_id
 * are linked in strict fill-time order; contradictory streams are marked incomplete. */
export function buildLivePortfolio(orders:FillOrder[],watches:Watch[],strategy:StrategyConfig,valueType:'price'|'mcap',interval:'30s'|'1m',now=Date.now()){
 const cycles:LiveCycle[]=[],active=new Map<string,LiveCycle>(),sequence=new Map<string,number>();
 let incompleteCount=0;
 const sorted=[...orders].sort((a,b)=>num(a.fill_time)-num(b.fill_time)||num(a.decision_time??0)-num(b.decision_time??0)||a.id.localeCompare(b.id));
 for(const o of sorted){
  const qty=num(o.quantity),gross=num(o.gross_amount),fee=num(o.fee),slip=num(o.slippage_cost),tax=num(o.tax_cost),time=num(o.fill_time),value=num(o.fill_value),mcap=o.market_cap==null?null:num(o.market_cap);
  if(!finitePositive(qty)||!finitePositive(gross)||!Number.isFinite(time)||!finitePositive(value)||![fee,slip,tax].every(x=>Number.isFinite(x)&&x>=0)){incompleteCount++;continue;}
  const k=key(o.chain,o.ca),existing=active.get(k);
  if(o.side==='buy'){
   if(existing && o.position_id && existing.id!==o.position_id){existing.status='incomplete';active.delete(k);incompleteCount++;}
   const current=active.get(k);
   if(current){
    current.orderIds.push(o.id);if(!current.pairIds.includes(o.pair_id))current.pairIds.push(o.pair_id);
    current.buyAmount+=gross;current.buyCost+=fee+slip+tax;current.buyValue=current.buyValue===null?null:(current.buyValue*current.buyQuantity+value*qty)/(current.buyQuantity+qty);
    current.buyMarketCap=current.buyMarketCap===null||mcap===null||!Number.isFinite(mcap)?null:(current.buyMarketCap*current.buyQuantity+mcap*qty)/(current.buyQuantity+qty);
    current.buyQuantity+=qty;current.quantity+=qty;current.remainingCost+=gross+fee+slip+tax;current.entryCount++;
   }else{
    const tradeNo=(sequence.get(k)??0)+1;sequence.set(k,tradeNo);
    const c:LiveCycle={id:o.position_id??o.id,chain:o.chain,ca:o.ca,pairId:o.pair_id,pairIds:[o.pair_id],orderIds:[o.id],tradeNo,buyTime:time,buyReason:o.reason,buyAmount:gross,buyCost:fee+slip+tax,buyQuantity:qty,buyValue:value,buyMarketCap:mcap!==null&&Number.isFinite(mcap)?mcap:null,entryCount:1,sellTime:null,sellReason:null,sellValue:null,sellMarketCap:null,sellAmount:0,sellQuantity:0,realizedPnl:0,quantity:qty,remainingCost:gross+fee+slip+tax,status:'open',unrealizedPnl:null,valuationTime:null,takeProfitValue:null,stopLossValue:null,exitLevelReason:null};
    cycles.push(c);active.set(k,c);
   }
  }else if(o.side==='sell'){
   if(!existing||qty>existing.quantity+1e-9||(o.position_id&&existing.id!==o.position_id)){incompleteCount++;if(existing){existing.status='incomplete';active.delete(k);}continue;}
   existing.orderIds.push(o.id);if(!existing.pairIds.includes(o.pair_id))existing.pairIds.push(o.pair_id);
   const basis=existing.remainingCost*Math.min(1,qty/existing.quantity),net=gross-fee-slip-tax;
   existing.remainingCost-=basis;existing.quantity-=qty;existing.realizedPnl+=net-basis;existing.sellAmount+=net;existing.sellQuantity+=qty;
   existing.sellTime=time;existing.sellReason=o.reason;existing.sellValue=value;existing.sellMarketCap=mcap!==null&&Number.isFinite(mcap)?mcap:null;
   if(existing.quantity<=1e-9){existing.quantity=0;existing.remainingCost=0;existing.status='closed';active.delete(k);}
  }
 }
 const watchByCa=new Map(watches.map(w=>[key(w.chain,w.ca),w]));
 const maxAge=interval==='30s'?120_000:180_000;
 for(const c of active.values()){
  const w=watchByCa.get(key(c.chain,c.ca)),p=w?.state_json?.position;
  const price=num(w?.state_json?.lastTokenPrice),at=dateMs(w?.last_trade_at??null);
  if(!p||!finitePositive(p.quantity)||Math.abs(num(p.quantity)-c.quantity)>Math.max(1e-8,c.quantity*0.001)){c.status='incomplete';incompleteCount++;continue;}
  if(Number.isFinite(at)&&now-at>=0&&now-at<=maxAge&&finitePositive(price)){
   const exit=strategy.executionConfig,sellCost=(exit.feePercent+exit.slippagePercent+exit.sellTaxPercent)/100;
   c.unrealizedPnl=c.quantity*price*(1-sellCost)-c.remainingCost;c.valuationTime=at;
  }
  try{
   const activeTrade={trade:{entryPrice:num(p.entryPrice)},impulse:p.impulse} as never;
   const base=stopPrice(strategy as never,activeTrade),target=targetPrice(strategy as never,activeTrade,base),lock=num(p.lockPrice);
   c.stopLossValue=Number.isFinite(base)?Math.max(base,Number.isFinite(lock)?lock:-Infinity):null;
   c.takeProfitValue=Number.isFinite(target)&&target>num(p.entryPrice)?target:null;
   c.exitLevelReason=Number.isFinite(lock)&&lock>base?'动态锁盈线与固定止损线取较高值':'策略止损位';
  }catch{/* Old or incomplete strategy state must not produce guessed levels. */}
 }
 const open=cycles.filter(c=>c.status==='open').sort((a,b)=>b.buyTime-a.buyTime),closed=cycles.filter(c=>c.status==='closed').sort((a,b)=>(b.sellTime??0)-(a.sellTime??0));
 const known=open.filter(c=>c.unrealizedPnl!==null),totalUnrealized=known.length===open.length?known.reduce((sum,c)=>sum+c.unrealizedPnl!,0):null;
 const summary={openCount:open.length,openCost:open.reduce((sum,c)=>sum+c.remainingCost,0),unrealizedPnl:totalUnrealized,unpricedCount:open.length-known.length,closedCount:closed.length,realizedPnl:closed.reduce((sum,c)=>sum+c.realizedPnl,0),winRate:closed.length?closed.filter(c=>c.realizedPnl>0).length/closed.length*100:null,incompleteCount};
 return {open,closed,cycles,summary};
}
