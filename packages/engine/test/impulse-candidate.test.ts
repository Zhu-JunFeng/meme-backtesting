import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {Candle,ImpulseConfig} from '@meme/domain';
import {withCurrentImpulseSelection} from '@meme/domain';
import {advanceImpulseCandidate,detectImpulse,LiveEvaluator,ResumableEngine,normalizeCandles,runBacktest,type Impulse} from '../src/index.js';
import {configuration,candles,symbols} from './fixtures.js';

const cfg:ImpulseConfig={type:'impulse_fractal_swing',selectionVersion:'pullback-v2',leftBars:1,rightBars:1,lookbackBars:100,minGainPercent:100,maxDurationBars:30,requireVolumeExpansion:false};
const bars=(values:number[])=>values.map((close,i):Candle=>({time:i*30000,closeTime:(i+1)*30000,open:close,high:close,low:close,close,volume:10}));
const replay=(history:Candle[],config=cfg)=>{let pending:Impulse|undefined;for(let end=1;end<=history.length;end++)pending=advanceImpulseCandidate(history,config,pending,0,undefined,end).impulse;return pending;};

describe('pullback-v2 selection and lifecycle',()=>{
 it('rejects an intervening higher High and can use a different valid historical pair',()=>{
  const rows=bars([12,10,14,30,20,18,22,25,21]);
  expect(detectImpulse(rows,{...cfg,selectionVersion:undefined})).toMatchObject({lowIndex:1,highIndex:7});
  expect(detectImpulse(rows,cfg)).toMatchObject({lowIndex:1,highIndex:3});
  rows[1].high=31;expect(detectImpulse(rows,cfg)).toBeUndefined(); // inclusive low endpoint
 });
 it('tries earlier lows when the nearest low fails gain, without weakening thresholds',()=>{
  expect(detectImpulse(bars([12,10,14,20,16,17,30,25]),cfg)).toMatchObject({lowIndex:1,highIndex:6});
  expect(detectImpulse(bars([12,10,14,20,16,17,30,25]),{...cfg,maxDurationBars:3})).toBeUndefined();
 });
 it('locks through small swings, wick breakout and equal close',()=>{
  const rows=bars([12,10,14,20,18,16,19,18]);rows[6].high=25;
  expect(replay(rows)).toMatchObject({lowIndex:1,highIndex:3});
  rows.push({...bars([20])[0],time:240000,closeTime:270000});
  expect(replay(rows)).toMatchObject({highIndex:3});
 });
 it('invalidates only on a strictly higher close, resets edge, cannot revive on return',()=>{
  const rows=bars([12,10,14,20,18,21,18]);
  const pending=replay(rows.slice(0,5));
  expect(advanceImpulseCandidate(rows,cfg,pending,0,undefined,6)).toEqual({impulse:undefined,changed:true});
  expect(replay(rows)).toMatchObject({highIndex:5}); // new high confirmed now, not at breakout
  expect(detectImpulse(rows,{...cfg,maxDurationBars:3})).toBeUndefined(); // old pair still forbidden
 });
 it('can replace with another already-confirmed range on the breakout bar',()=>{
  const rows=bars([12,10,14,20,18,19,22]);rows[5].high=30;
  const pending=replay(rows.slice(0,6));expect(pending?.high).toBe(20);
  const next=advanceImpulseCandidate(rows,cfg,pending);
  expect(next).toMatchObject({changed:true,impulse:{lowIndex:1,highIndex:5,high:30}});
 });
 it('rejects close below low, expires lookback, and breaks tied pivots by time',()=>{
  expect(replay(bars([12,10,14,20,18,9]))).toBeUndefined();
  expect(replay(bars([12,10,14,20,18,16,17,16]),{...cfg,lookbackBars:5})).toBeUndefined();
  expect(detectImpulse(bars([12,10,14,20,18,20,18]),cfg)).toMatchObject({highIndex:5,lowIndex:1});
  expect(replay(bars([12,10,14,20,18,10]))).toMatchObject({low:10,high:20});
 });
 it('bounded incremental pivots, live warmup and restore reproduce prefix replay',()=>{
  const config=withCurrentImpulseSelection(configuration());config.entryConditionGroup={enabled:false,mode:'all',conditions:[]};
  let resumable=new ResumableEngine(config),live=new LiveEvaluator(config,0);let expected:Impulse|undefined;
  const rows=normalizeCandles(candles(1500),'30s').candles;
  for(let n=0;n<rows.length;n++){
   expected=advanceImpulseCandidate(rows,config.impulseCondition,expected,0,undefined,n+1).impulse;
   resumable.step([{symbol:symbols[0],candle:rows[n],last:false}]);
   expect(live.onClosedCandle(rows[n],true)).toBeUndefined();
   const actual=resumable.s.states[0].pendingImpulse;
   expect(actual).toEqual(expected);
   const lp=live.state.pendingImpulse;
   expect(lp&&{...lp,lowIndex:lp.lowIndex+(n+1-live.state.history.length),highIndex:lp.highIndex+(n+1-live.state.history.length),confirmedAtIndex:lp.confirmedAtIndex+(n+1-live.state.history.length)}).toEqual(expected);
   if(n%17===0){resumable=new ResumableEngine(config,JSON.parse(JSON.stringify(resumable.checkpoint())));live=new LiveEvaluator(config,0,live.snapshot());}
   resumable.drain();
  }
 });
 it('cutover rebuilds flat candidates only and preserves all held position fields',()=>{
  const config=withCurrentImpulseSelection(configuration());config.impulseCondition={...cfg};
  const old=new LiveEvaluator({...config,impulseCondition:{...cfg,selectionVersion:undefined}},0);
  for(const c of bars([12,10,14,20,18,21]))old.onClosedCandle(c,true);
  const cutover=new LiveEvaluator(config,0,old.snapshot());expect(cutover.state.pendingImpulse).toBeUndefined();
  old.state.position={entryPrice:15,quantity:2,entries:2,entryTime:120000,entryBar:4,impulse:{...detectImpulse(bars([12,10,14,20,18]),cfg)!},tradeNo:1,lockPrice:16,lockTier:0,costBasisUsd:31};
  const held=new LiveEvaluator(config,0,old.snapshot());expect(held.state.position).toEqual(old.state.position);
  const anchor=structuredClone(held.state.position!.impulse);
  held.onClosedCandle({...bars([40])[0],time:180000,closeTime:210000},true);
  expect(held.state.position!.impulse).toEqual(anchor);expect(held.state.position!.lockPrice).toBe(16);
 });
 it('new entry snapshots do not share the mutable pending object',()=>{
  const config=withCurrentImpulseSelection(configuration());config.impulseCondition={...cfg};config.entryAfterSignal=false;
  const live=new LiveEvaluator(config,0);let decision;
  for(const c of bars([12,10,14,20,18,15]))decision=live.onClosedCandle(c)??decision;
  expect(decision?.impulse).toBeDefined();expect(decision!.impulse).not.toBe(live.state.pendingImpulse);
 });
 it('clears old-pool candidates when a flat feed resets its history',()=>{
  const config=withCurrentImpulseSelection(configuration());config.impulseCondition={...cfg};
  const live=new LiveEvaluator(config,0);for(const c of bars([12,10,14,20,18]))live.onClosedCandle(c,true);
  expect(live.state.pendingImpulse?.high).toBe(20);
  const state=live.snapshot();state.history=[];state.lastCandleTime=undefined;
  const reset=new LiveEvaluator(config,0,state);expect(reset.state.pendingImpulse).toBeUndefined();
  reset.onClosedCandle(bars([15])[0],true);expect(reset.state.pendingImpulse).toBeUndefined();
  expect(advanceImpulseCandidate(bars([15]),cfg,state.pendingImpulse).impulse).toBeUndefined();
 });
 it('all three executors enter on the same closed bar and holding anchors survive later breakout/add/exit',()=>{
  const config=withCurrentImpulseSelection(configuration());config.impulseCondition={...cfg};config.entryAfterSignal=false;
  config.exitConfig={stopLoss:{type:'swing_low',bufferPercent:0},takeProfit:{type:'percent',value:1000},closeAtEnd:false};
  config.positionConfig.allowReentry=false;config.addConditionGroup={mode:'all',conditions:[{type:'fib_retracement',zoneLow:.4,zoneHigh:.6}]};
  const rows=bars([12,10,14,20,18,15,25,15,9]);
  const ref=runBacktest(config,[{symbol:symbols[0],candles:rows}]),engine=new ResumableEngine(config),live=new LiveEvaluator(config,0);
  const decisions:any[]=[];let anchor:Impulse|undefined;
  for(const c of rows){
   engine.step([{symbol:symbols[0],candle:c,last:false}]);
   const d=live.onClosedCandle(c);
   if(d){decisions.push(d);
    if(d.reason==='entry'){anchor=structuredClone(d.impulse);live.state.position={entryPrice:c.close,quantity:1,entries:1,entryTime:d.time,entryBar:live.state.history.length-1,impulse:structuredClone(d.impulse!),tradeNo:1};}
    else if(d.reason==='add')live.state.position!.entries++;
   }
   if(live.state.position)expect(live.state.position.impulse).toEqual(anchor);
  }
  const output=engine.drain();
  expect(decisions.map(d=>d.reason)).toEqual(['entry','add','add','stop_loss']);
  expect(decisions.map(d=>({time:d.time-30000,value:d.value,type:d.reason}))).toEqual(output.signals.map(s=>({time:s.time,value:s.price,type:s.type})));
  expect(ref.signals.map(s=>({time:s.time,price:s.price,type:s.type}))).toEqual(output.signals.map(s=>({time:s.time,price:s.price,type:s.type})));
  expect((output.signals[0].reason.impulse as Impulse).high).toBe(20);
 });
 it('legacy checkpoints cannot silently enable new selection, and vice versa',()=>{
  const legacy=configuration(),modern=withCurrentImpulseSelection(legacy),cp=new ResumableEngine(legacy).checkpoint();
  cp.version=4;cp.engineVersion='portfolio-5';delete cp.impulseSelectionVersion;
  expect(()=>new ResumableEngine(legacy,cp)).not.toThrow();
  expect(()=>new ResumableEngine(modern,cp)).toThrow('不兼容');
  expect(()=>new ResumableEngine(legacy,new ResumableEngine(modern).checkpoint())).toThrow('不兼容');
 });
 it('reselects after a confirmed exit, but never buys again on the same sell bar',()=>{
  const config=withCurrentImpulseSelection(configuration());config.impulseCondition={...cfg};config.entryAfterSignal=false;
  config.positionConfig.mode='single_entry';config.exitConfig={stopLoss:{type:'percent',value:2},takeProfit:{type:'percent',value:1000},closeAtEnd:false};
  const rows=bars([12,10,14,20,18,17,17,18]);
  const ref=runBacktest(config,[{symbol:symbols[0],candles:rows}]),engine=new ResumableEngine(config),live=new LiveEvaluator(config,0);
  const entries:number[]=[];
  for(const c of rows){
   engine.step([{symbol:symbols[0],candle:c,last:false}]);const d=live.onClosedCandle(c);
   if(d?.reason==='entry'){entries.push(c.time);live.state.position={entryPrice:c.close,quantity:1,entries:1,entryTime:d.time,entryBar:live.state.history.length-1,impulse:structuredClone(d.impulse!),tradeNo:live.state.trades+1};}
   else if(d?.side==='sell'){live.state.position=undefined;live.state.trades++;}
   live.confirmClose(c);
  }
  expect(entries).toEqual([120000,180000]);
  expect(ref.signals.filter(s=>s.type==='entry').map(s=>s.time)).toEqual(entries);
  expect(engine.drain().signals.filter(s=>s.type==='entry').map(s=>s.time)).toEqual(entries);
 });
});

describe('SOL 3HKK actual market regression (Beijing 2026-10-10)',()=>{
 const rows=JSON.parse(readFileSync(new URL('./fixtures/sol-3HKK-20261010.json',import.meta.url),'utf8')) as Candle[];
 const config:ImpulseConfig={...cfg,leftBars:3,rightBars:3,minGainPercent:150,requireVolumeExpansion:true,volumeExpansionRatio:1.5};
 it('refuses 09:37:30 → 09:49:30: 09:41:30 High exceeds 687.61K',()=>{
  expect(rows).toHaveLength(153);
  expect(rows[85].high).toBeCloseTo(702541.0080959917);
  expect(rows[101].high).toBeCloseTo(687609.0834543202);
  expect(detectImpulse(rows,{...config,selectionVersion:undefined})).toMatchObject({lowIndex:77,highIndex:101});
  for(let end=105;end<=rows.length;end++)expect(advanceImpulseCandidate(rows,config,undefined,0,undefined,end).impulse).not.toMatchObject({lowIndex:77,highIndex:101});
 });
 it('replays confirmed selections without future data and does not relax 150% / 30 bars',()=>{
  let pending:Impulse|undefined;const invalidated=new Set<string>();
  const base=withCurrentImpulseSelection(configuration());base.impulseCondition=config;base.entryConditionGroup={enabled:false,mode:'all',conditions:[]};
  const live=new LiveEvaluator(base,0),engine=new ResumableEngine(base);
  for(let n=0;n<rows.length;n++){
   if(pending&&(rows[n].close>pending.high||rows[n].close<pending.low))invalidated.add(`${pending.lowTime}:${pending.highTime}`);
   pending=advanceImpulseCandidate(rows,config,pending,0,undefined,n+1).impulse;
   engine.step([{symbol:symbols[0],candle:rows[n],last:false}]);live.onClosedCandle(rows[n],true);
   expect(engine.s.states[0].pendingImpulse).toEqual(pending);expect(live.state.pendingImpulse).toEqual(pending);
   if(pending){expect(invalidated.has(`${pending.lowTime}:${pending.highTime}`)).toBe(false);expect(pending.confirmedAtIndex).toBeLessThanOrEqual(n);expect(pending.gainPercent).toBeGreaterThanOrEqual(150);expect(pending.highIndex-pending.lowIndex).toBeLessThanOrEqual(30);}
   engine.drain();
  }
  expect(invalidated.size).toBeGreaterThan(0);expect(pending).toBeUndefined();
 });
});
