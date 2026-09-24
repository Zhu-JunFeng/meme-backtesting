import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertLocalDatabase,LocalCandleReader,evaluateWindow,realCandleAt} from './offline-strategy-research.mjs';
import {normalizeCandles,runBacktest} from '../packages/engine/dist/index.js';
const symbol={chain:'sol',ca:'test',pairId:'pool'};
test('rejects remote database hosts',()=>{for(const host of ['47.251.140.83','example.com',undefined])assert.throws(()=>assertLocalDatabase({host}));for(const host of ['127.0.0.1','localhost','::1','/tmp/socket'])assert.doesNotThrow(()=>assertLocalDatabase({host}));});
test('rejects a remote connection string overriding the local host',()=>assert.throws(()=>assertLocalDatabase({host:'localhost',connectionString:'postgres://example.com/database'})));
test('lazy gaps use previous close and equal production normalization',()=>{const rows=[{time:0,closeTime:30000,open:2,high:3,low:1,close:2,volume:3},{time:90000,closeTime:120000,open:4,high:5,low:3,close:4,volume:4}];const reader=new LocalCandleReader({symbol,candles:rows},0,120000,30000),actual=[];let t;while(t=reader.peek()){actual.push({...t.candle,valid:true});reader.consume(t.candle);}assert.deepEqual(actual,normalizeCandles(rows,'30s').candles);});
test('window is half-open and does not fabricate trailing candles',()=>{const rows=[0,30000,60000].map(time=>({time,closeTime:time+30000,open:1,high:1,low:1,close:1,volume:1}));const reader=new LocalCandleReader({symbol,candles:rows},30000,60000,30000);const t=reader.peek();assert.equal(t.candle.time,30000);assert.equal(t.last,true);reader.consume(t.candle);assert.equal(reader.peek(),undefined);});
test('real candle audit distinguishes a gap-filled timestamp',()=>{const rows=[{time:0},{time:60000}];assert(realCandleAt(rows,0));assert(!realCandleAt(rows,30000));assert(realCandleAt(rows,60000));});
test('empty evaluation keeps initial balance and reports no unsupported win rate',()=>{const config={name:'test',symbols:[symbol],interval:'30s',valueType:'mcap',impulseCondition:{type:'impulse_fractal_swing',leftBars:2,rightBars:2,lookbackBars:100,minGainPercent:80,maxDurationBars:30,requireVolumeExpansion:false},entryConditionGroup:{mode:'all',conditions:[{type:'fib_retracement',zoneLow:.618,zoneHigh:.786}]},invalidationConditionGroup:{mode:'all',enabled:false,conditions:[]},exitConfig:{stopLoss:{type:'percent',value:10},takeProfit:{type:'risk_reward',ratio:2},closeAtEnd:true},positionConfig:{mode:'single_entry',maxEntries:1,maxConcurrentPositions:1,allowReentry:true,sizing:{type:'fixed_percent',value:1}},executionConfig:{initialCapital:100000,feePercent:.3,slippagePercent:1,buyTaxPercent:1,sellTaxPercent:1,fillMode:'current_bar_close'}};const r=evaluateWindow({id:1,config},[{symbol,candles:[]}],0,86400000);assert.equal(r.accountReturn,0);assert.equal(r.normalReturn,0);assert.equal(r.normalTrades,0);assert.equal(r.winRate,null);assert.equal(config.entryConditionGroup.enabled,undefined);});
function fixture(){
 const symbols=[symbol,{chain:'sol',ca:'b',pairId:'b'}];
 const config={name:'parity',symbols,interval:'30s',valueType:'mcap',impulseCondition:{type:'impulse_fractal_swing',leftBars:2,rightBars:2,lookbackBars:30,minGainPercent:10,maxDurationBars:20,requireVolumeExpansion:false},entryConditionGroup:{mode:'all',conditions:[{type:'fib_retracement',zoneLow:.2,zoneHigh:.8}]},invalidationConditionGroup:{enabled:false,mode:'any',conditions:[]},exitConfig:{stopLoss:{type:'percent',value:10},takeProfit:{type:'risk_reward',ratio:2},closeAtEnd:true},executionConfig:{initialCapital:1000,feePercent:1,slippagePercent:1,buyTaxPercent:1,sellTaxPercent:1,fillMode:'current_bar_close'},positionConfig:{mode:'single_entry',maxEntries:1,maxConcurrentPositions:2,allowReentry:true,sizing:{type:'fixed_percent',value:10}}};
 const inputs=symbols.map((symbol,offset)=>({symbol,candles:Array.from({length:500},(_,i)=>{const close=10+Math.sin(i*.42)*3+Math.sin(i*.71);return{time:(i+offset)*30000,closeTime:(i+offset+1)*30000,open:close*(1+Math.cos(i)*.015),high:close*1.05,low:close*.95,close,volume:100+(i%11)*20};}).filter((_,i)=>i%31!==0)}));return{config,inputs};
}
test('offline cursor reproduces reference account and normal-closed results',()=>{
 const {config,inputs}=fixture(),before=structuredClone(config),reference=runBacktest(config,inputs);
 const actual=evaluateWindow({id:1,config},inputs,0,502*30000,{warmupBars:0});
 assert(reference.report.totalTrades>0);assert.equal(actual.accountReturn,reference.report.returnPercent);assert.equal(actual.accountMaxDrawdown,reference.report.maxDrawdownPercent);
 const normal=reference.trades.filter(t=>t.exitReason!=='end_of_backtest');assert.equal(actual.normalTrades,normal.length);assert.equal(actual.normalNet,normal.reduce((n,t)=>n+t.netPnl,0));assert.deepEqual(config,before);
 const byCa=new Map();for(const t of normal){const k=`${t.symbol.chain}:${t.symbol.ca}`;byCa.set(k,(byCa.get(k)||0)+t.netPnl);}assert.equal(actual.topCaPnl,Math.max(0,...byCa.values()));if(actual.topCaPnl>0)assert.equal(byCa.get(actual.topCaKey),actual.topCaPnl);else assert.equal(actual.topCaKey,null);
});
test('detailed audit counts entries occurring on synthetic gap fills',()=>{
 const {config,inputs}=fixture();config.entryAfterSignal=true;config.entrySignals=inputs.map(p=>({chain:p.symbol.chain,ca:p.symbol.ca,signalTime:0}));
 const reference=runBacktest(config,inputs);
 const actual=evaluateWindow({id:'audit',config},inputs,0,502*30000,{warmupBars:0,detail:true});
 const synthetic=reference.trades.filter(t=>!realCandleAt(inputs.find(p=>p.symbol.ca===t.symbol.ca).candles,t.entryTime));
 assert.equal(actual.audit.syntheticEntryTrades,synthetic.length);
 assert(Math.abs(actual.audit.syntheticEntryNetPnl-synthetic.reduce((n,t)=>n+t.netPnl,0))<1e-8);
});
test('historical warm-up updates indicators but never opens positions',()=>{
 const {config,inputs}=fixture(),actual=evaluateWindow({id:1,config},inputs,502*30000,600*30000,{warmupBars:1500});
 assert(actual.processedBars>0);assert.equal(actual.normalTrades,0);assert.equal(actual.excludedCount,0);assert.equal(actual.netPnl,0);
});
test('terminal close uses each pool last available real close, includes every cost and leaves no unrealized gain',()=>{
 const {config,inputs}=fixture();config.positionConfig.allowReentry=false;config.exitConfig={stopLoss:{type:'percent',value:99},takeProfit:{type:'percent',value:10000},closeAtEnd:true};
 inputs[0].candles=inputs[0].candles.slice(0,60);inputs[1].candles=inputs[1].candles.slice(0,95);
 const reference=runBacktest(config,inputs);assert.equal(reference.trades.length,2);assert.equal(reference.report.openPositions.length,0);
 for(const t of reference.trades){const last=inputs.find(p=>p.symbol.ca===t.symbol.ca).candles.at(-1);assert.equal(t.exitReason,'end_of_backtest');assert.equal(t.exitTime,last.time);assert.equal(t.exitPrice,last.close);assert(t.fees>0&&t.slippageCost>0&&t.taxCost>0);assert(Math.abs(t.netPnl-(t.grossPnl-t.fees-t.slippageCost-t.taxCost))<1e-8);}
 const actual=evaluateWindow({id:'terminal',config},inputs,0,600*30000,{warmupBars:0});assert.equal(actual.totalTrades,2);assert.equal(actual.normalTrades,0);assert.equal(actual.excludedCount,2);assert.equal(actual.netPnl,reference.report.netPnl);assert.equal(actual.accountReturn,actual.excludedNet/config.executionConfig.initialCapital*100);
});
