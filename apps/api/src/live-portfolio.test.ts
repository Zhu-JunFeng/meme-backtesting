import {describe,expect,it} from 'vitest';
import {buildLivePortfolio} from './live-portfolio.js';

const strategy={executionConfig:{feePercent:1,slippagePercent:1,sellTaxPercent:1},exitConfig:{stopLoss:{type:'percent',value:10},takeProfit:{type:'percent',value:50}}} as never;
const baseTime=1_780_000_000_000;
function fill(id:string,side:'buy'|'sell',time:number,quantity:number,gross:number,options:{position_id?:string;value?:number;price?:number;mcap?:number;fee?:number;slip?:number;tax?:number}={}){
 return {id,position_id:options.position_id??null,chain:'sol',ca:'A',pair_id:'P',side,reason:side==='buy'?'entry':'take_profit',fill_time:time,fill_value:options.value??10,fill_price:options.price??10,market_cap:options.mcap??100_000,quantity,gross_amount:gross,fee:options.fee??0,slippage_cost:options.slip??0,tax_cost:options.tax??0};
}
describe('live portfolio accounting',()=>{
 it('groups an entry, add and exit into one closed position with net costs',()=>{
  const orders=[fill('b1','buy',baseTime,10,100,{fee:1,position_id:'b1'}),fill('b2','buy',baseTime+1000,5,50,{fee:1,position_id:'b1'}),fill('s1','sell',baseTime+2000,15,180,{fee:2,position_id:'b1'})];
  const result=buildLivePortfolio(orders,[],strategy,'mcap','30s',baseTime+3000);
  expect(result.open).toHaveLength(0);expect(result.closed).toHaveLength(1);
  expect(result.closed[0]).toMatchObject({buyAmount:150,buyCost:2,entryCount:2,sellAmount:178,realizedPnl:26});
  expect(result.summary).toMatchObject({closedCount:1,realizedPnl:26,winRate:100});
 });
 it('keeps a later re-entry independent from the first completed position',()=>{
  const orders=[fill('b1','buy',baseTime,10,100,{position_id:'b1'}),fill('s1','sell',baseTime+1000,10,120,{position_id:'b1'}),fill('b2','buy',baseTime+2000,5,50,{position_id:'b2'})];
  const watches=[{chain:'sol',ca:'A',last_trade_at:new Date(baseTime+3000).toISOString(),state_json:{position:{quantity:5,entryPrice:10,impulse:{low:5,high:20}},lastTokenPrice:12}}];
  const result=buildLivePortfolio(orders,watches,strategy,'price','30s',baseTime+4000);
  expect(result.closed[0].id).toBe('b1');expect(result.open[0].id).toBe('b2');
  expect(result.open[0].unrealizedPnl).toBeCloseTo(8.2);expect(result.open[0].takeProfitValue).toBe(15);expect(result.open[0].stopLossValue).toBe(9);
 });
 it('does not invent current profit from stale quotes or contradictory fills',()=>{
  const orders=[fill('b1','buy',baseTime,10,100),fill('s1','sell',baseTime+1000,20,200)];
  const result=buildLivePortfolio(orders,[],strategy,'mcap','30s',baseTime+5000);
  expect(result.closed).toHaveLength(0);expect(result.summary.incompleteCount).toBeGreaterThan(0);
  const staleWatch=[{chain:'sol',ca:'A',last_trade_at:new Date(baseTime-300_000).toISOString(),state_json:{position:{quantity:10,entryPrice:10,impulse:{low:5,high:20}},lastTokenPrice:12}}];
  const pending=buildLivePortfolio([fill('b1','buy',baseTime,10,100)],staleWatch,strategy,'mcap','30s',baseTime+5000);
  expect(pending.open[0].unrealizedPnl).toBeNull();expect(pending.summary.unrealizedPnl).toBeNull();
 });
});
