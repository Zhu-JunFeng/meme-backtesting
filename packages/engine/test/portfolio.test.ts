import { describe,it,expect } from "vitest";
import type { BacktestConfig,Candle,SymbolRef } from "@meme/domain";
import {runBacktest,runBacktestAsync} from "../src/index.js";
const a:SymbolRef={chain:"sol",ca:"a",pairId:"a"},b:SymbolRef={chain:"sol",ca:"b",pairId:"b"};
const config=():BacktestConfig=>({
 name:"portfolio",schemaVersion:1,symbols:[a,b],interval:"30s",valueType:"mcap",
 impulseCondition:{type:"impulse_fractal_swing",leftBars:2,rightBars:2,lookbackBars:100,minGainPercent:20,maxDurationBars:30,requireVolumeExpansion:false},
 entryConditionGroup:{mode:"all",conditions:[{type:"fib_retracement",zoneLow:.2,zoneHigh:.8}]},
 invalidationConditionGroup:{mode:"any",enabled:false,conditions:[]},
 exitConfig:{stopLoss:{type:"percent",value:90},takeProfit:{type:"percent",value:1000},closeAtEnd:true},
 executionConfig:{initialCapital:1000,feePercent:1,slippagePercent:1,buyTaxPercent:1,sellTaxPercent:1,fillMode:"current_bar_close"},
 positionConfig:{mode:"single_entry",maxEntries:1,maxConcurrentPositions:2,allowReentry:false,sizing:{type:"fixed_amount",value:100}}
});
const bars=(scale=1,offset=0,values=[1.2,1.1,1,1.2,1.5,1.8,1.7,1.6,1.6,1.6]):Candle[]=>values.map((v,i)=>({time:offset+i*30000,closeTime:offset+(i+1)*30000,open:v*scale,high:v*scale*1.02,low:v*scale*.98,close:v*scale,volume:100}));
describe("chronological shared portfolio",()=>{
 it("cooperative worker execution gives exactly the synchronous result",async()=>{
  const c=config(),inputs=[{symbol:a,candles:bars()},{symbol:b,candles:bars(100)}];
  expect(await runBacktestAsync(c,inputs)).toEqual(runBacktest(c,inputs));
 });
 it("is deterministic under reversed inputs, includes zero-trade pools and closes before final equity",()=>{
  const c=config(),inputs=[{symbol:a,candles:bars()},{symbol:b,candles:bars(100)},{symbol:{...a,pairId:"empty"},candles:[]}];
  const first=runBacktest(c,inputs),second=runBacktest(c,[...inputs].reverse());
  expect(first).toEqual(second);expect(first.report.totalTrades).toBe(2);
  expect(first.report.bySymbol).toHaveLength(3);
  expect(first.report.finalEquity).toBeCloseTo(1000+first.report.netPnl,8);
  expect(first.report.bySymbol.reduce((s,p)=>s+p.netPnl,0)).toBeCloseTo(first.report.netPnl);
  expect(first.signals.filter(s=>s.type==="end_of_backtest")).toHaveLength(2);
 });
 it("marks open holdings with their own prices and keeps realized separate",()=>{
  const c=config();c.exitConfig.closeAtEnd=false;
  const r=runBacktest(c,[{symbol:a,candles:bars()},{symbol:b,candles:bars(100)}]);
  expect(r.report.openPositions).toHaveLength(2);
  expect(r.report.netPnl).toBe(0);
  expect(r.report.unrealizedPnl).toBeCloseTo(-6);
  expect(r.report.finalEquity).toBeCloseTo(994);
  expect(r.equity.at(-1)?.unrealized).toBeCloseTo(0);
  expect(r.trades.every(t=>t.exitTime===undefined)).toBe(true);
  expect(r.signals.filter(s=>s.type==="risk_event")).toHaveLength(2);
 });
 it("never spends fees beyond cash and enforces the global holding limit",()=>{
  const c=config();c.positionConfig.sizing.value=1000;c.positionConfig.maxConcurrentPositions=1;c.exitConfig.closeAtEnd=false;
  const r=runBacktest(c,[{symbol:b,candles:bars(100)},{symbol:a,candles:bars()}]);
  expect(r.signals.filter(s=>s.type==="entry")).toHaveLength(1);
  expect(r.signals.find(s=>s.type==="entry")?.symbol).toEqual(a);
  expect(Math.min(...r.equity.map(p=>p.cash))).toBeGreaterThanOrEqual(-1e-10);
 });
 it("handles disjoint lifecycles with shared capital",()=>{
  const c=config();c.positionConfig.maxConcurrentPositions=1;
  const r=runBacktest(c,[{symbol:b,candles:bars(100,600000)},{symbol:a,candles:bars()}]);
  expect(r.report.totalTrades).toBe(2);
  expect(r.equity.every((p,i)=>i===0 || p.time>r.equity[i-1].time)).toBe(true);
 });
 it("uses all pool exits before competing entries at the same time",()=>{
  const c=config();c.positionConfig.maxConcurrentPositions=1;
  const r=runBacktest(c,[{symbol:a,candles:bars(1,60000)},{symbol:b,candles:bars()}]);
  const lastB=r.signals.find(s=>s.type==="end_of_backtest" && s.symbol.ca==="b")!;
  const firstA=r.signals.find(s=>s.type==="entry" && s.symbol.ca==="a")!;
  expect(lastB).toBeDefined();expect(firstA).toBeDefined();expect(firstA.time).toBe(lastB.time);
  expect(r.signals.indexOf(lastB)).toBeLessThan(r.signals.indexOf(firstA));
 });
 it("preserves original entry/add event prices instead of average entry cost",()=>{
  const c=config();c.positionConfig.mode="pyramiding";c.positionConfig.maxEntries=2;
  c.addConditionGroup={mode:"all",conditions:[{type:"bullish_volume_confirmation",period:1,minRatio:2}]};
  const candles=bars();candles[8]={...candles[8],open:1.4,low:1.3,high:1.55,close:1.5,volume:300};
  const r=runBacktest(c,[{symbol:a,candles}]),entry=r.signals.find(s=>s.type==="entry")!,add=r.signals.find(s=>s.type==="add")!;
  expect(add).toBeDefined();expect(entry.price).toBe(1.6);expect(add.price).toBe(1.5);
  expect(r.trades[0].entryPrice).not.toBe(entry.price);
  expect(r.report.finalEquity).toBeCloseTo(1000+r.report.netPnl);
 });
 it("retains conservative stop priority over a same-candle target",()=>{
  const c=config();c.exitConfig.stopLoss={type:"percent",value:10};c.exitConfig.takeProfit={type:"percent",value:10};
  const candles=bars();candles[8]={...candles[8],low:1.3,high:2};
  const r=runBacktest(c,[{symbol:a,candles}]);expect(r.trades[0].exitReason).toBe("stop_loss");
 });
});
