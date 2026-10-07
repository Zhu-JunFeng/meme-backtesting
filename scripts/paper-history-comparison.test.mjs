import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectHistory,compareCandles,replay} from './paper-history-comparison.mjs';
import {runBacktest} from '../packages/engine/dist/index.js';
const req={chain:'sol',pairId:'CaseSensitive',interval:'30s',type:'mcap',from:30000,to:120000};
const row=(start_time,extra={})=>({start_time,open:'10',high:'12',low:'8',close:'11',volume:'100',...extra});
const body=items=>({success:true,code:'200',data:{chain:'sol',pair_address:'CaseSensitive',interval:'30s',value_type:'market_cap',items}});
test('clips windows and never repairs invalid OHLC; exact decimals survive',()=>{
 const r=inspectHistory(body([row(0),row(30000,{open:'10.123456789123456789'}),row(60000,{open:'13'}),row(90000),row(120000)]),req);
 assert.equal(r.valid.length,2);assert.equal(r.outside,1);assert(r.invalid.some(r=>r.reason==='invalid_ohlc'));assert.equal(r.valid[0].open,'10.123456789123456789');
});
test('rejects mismatched response and all conflicting timestamp versions',()=>{
 assert.throws(()=>inspectHistory({...body([]),code:200},req));assert.throws(()=>inspectHistory(body([]),{...req,pairId:'casesensitive'}));
 const r=inspectHistory(body([row(30000),row(30000,{close:'10'}),row(60000),row(60000)]),req);
 assert.deepEqual(r.valid.map(c=>c.time),[60000]);assert.equal(r.duplicates,2);
});
test('comparison only labels explicitly sourced WS records and separates missing times',()=>{
 const h=inspectHistory(body([row(30000),row(60000)]),req).valid;
 const stored=[{...h[0],source:'xxyy'},{...h[1],source:'meme_market_v2',synthetic:true,volume:'0'},{...h[0],time:90000,source:'meme_market_v2'}];
 const r=compareCandles(h,stored);assert.equal(r.ws,2);assert.equal(r.overlap,1);assert.equal(r.wsOnly,1);assert.equal(r.historyOnly,1);assert.equal(r.syntheticOverlap,1);assert.equal(r.fields.volume.different,1);
});
const symbol={chain:'sol',ca:'test',pairId:'pool'};
const config={symbols:[symbol],interval:'30s',valueType:'mcap',entryAfterSignal:true,entrySignals:[{chain:'sol',ca:'test',signalTime:300000}],impulseCondition:{type:'impulse_fractal_swing',leftBars:2,rightBars:2,lookbackBars:30,minGainPercent:10,maxDurationBars:20,requireVolumeExpansion:false},entryConditionGroup:{mode:'all',conditions:[{type:'fib_retracement',zoneLow:.2,zoneHigh:.8}]},invalidationConditionGroup:{enabled:false,mode:'any',conditions:[]},exitConfig:{stopLoss:{type:'percent',value:10},takeProfit:{type:'risk_reward',ratio:2},closeAtEnd:true},executionConfig:{initialCapital:10000,feePercent:1,slippagePercent:1,buyTaxPercent:1,sellTaxPercent:1,fillMode:'current_bar_close'},positionConfig:{mode:'single_entry',maxEntries:1,maxConcurrentPositions:2,allowReentry:true,sizing:{type:'fixed_percent',value:10}}};
test('audit replay equals reference, gates buys, and consumes stored synthetic bars once',()=>{
 const input={symbol,candles:Array.from({length:300},(_,i)=>{const close=10+Math.sin(i*.42)*3;return {time:i*30000,closeTime:(i+1)*30000,open:close,high:close*1.05,low:close*.95,close,volume:100,synthetic:i===5};}).filter((_,i)=>i%31!==0)};
 const before=structuredClone(config),a=replay(config,[input]),b=runBacktest(config,[input]);
 assert(a.trades.length>0);assert.equal(a.report.netPnl,b.report.netPnl);assert.equal(a.report.totalTrades,b.report.totalTrades);assert.deepEqual(config,before);
 assert(a.signals.filter(s=>s.type==='entry'||s.type==='add').every(s=>s.time>300000));assert(a.generatedGapBars>0);
});
test('empty input is explicitly zero trades, not a successful parity test',()=>{const r=replay(config,[{symbol,candles:[]}]);assert.equal(r.report.totalTrades,0);assert.equal(r.report.netPnl,0);});
