import {describe,it,expect} from 'vitest';
import {normalizeEntrySignals,type BacktestConfig,type Signal} from '@meme/domain';
import {ResumableEngine,normalizeCandles,runBacktest,CHECKPOINT_VERSION} from '../src/index.js';
import {createEntryGate} from '../src/entry-gate.js';
import {configuration,candles} from './fixtures.js';

function execute(config:BacktestConfig,resume=false){
 let engine=new ResumableEngine(config);const signals:Signal[]=[],trades:any[]=[];
 const bars=normalizeCandles(candles(250),config.interval).candles;
 const drain=()=>{const b=engine.drain();signals.push(...b.signals);trades.push(...b.trades);};
 for(let i=0;i<bars.length;i++){
  engine.step(config.symbols.map(symbol=>({symbol,candle:bars[i],last:i===bars.length-1})));
  if(resume && i%7===0){drain();engine=new ResumableEngine(config,JSON.parse(JSON.stringify(engine.checkpoint())));}
 }
 drain();return{report:engine.finish(),signals,trades,engine};
}
describe('externally observed signal entry gate',()=>{
 it('requires every selected CA and rejects invalid timestamps, preserves SOL address case',()=>{
  const refs=[{chain:'sol',ca:'A'},{chain:'sol',ca:'A',pairId:'p2'}];
  expect(normalizeEntrySignals([{chain:' SOL ',ca:'A',signalTime:20},{chain:'sol',ca:'A',signalTime:10}],refs)).toEqual([{chain:'sol',ca:'A',signalTime:10}]);
  for(const values of [[],[{chain:'sol',ca:'a',signalTime:10}],[{chain:'sol',ca:'A',signalTime:NaN}],[{chain:'sol',ca:'A',signalTime:1.5}]])expect(()=>normalizeEntrySignals(values,refs)).toThrow();
  expect(()=>normalizeEntrySignals([{chain:'sol',ca:'A',signalTime:10}],[...refs,{chain:'sol',ca:'B'}])).toThrow('缺少');
 });
 it('excludes equal/straddling buckets and shares a CA gate across pools but not chains',()=>{
  const c=configuration();c.symbols=[{chain:'sol',ca:'a',pairId:'p1'},{chain:'sol',ca:'a',pairId:'p2'},{chain:'robin',ca:'a',pairId:'p3'}];
  c.entrySignals=[{chain:'sol',ca:'a',signalTime:30001},{chain:'robin',ca:'a',signalTime:60000}];const g=createEntryGate(c);
  expect(g.allows(c.symbols[0],30000)).toBe(false);expect(g.allows(c.symbols[1],60000)).toBe(true);expect(g.allows(c.symbols[2],60000)).toBe(false);expect(g.allows(c.symbols[2],90000)).toBe(true);
 });
 it('applies the waiting boundary to both entry and add, without changing old configurations',()=>{
  const c=configuration();c.entrySignals=c.symbols.map(s=>({...s,signalTime:30001}));
  const prior=createEntryGate(c);expect(prior.allows(c.symbols[0],60000)).toBe(true);
  c.minimumSignalAgeMinutes=30;const gate=createEntryGate(c);
  expect(gate.allows(c.symbols[0],1800000)).toBe(false);
  expect(gate.allows(c.symbols[0],1830000)).toBe(false);
  expect(gate.allows(c.symbols[0],1860000)).toBe(true);
  const r=execute(c,true);for(const s of r.signals.filter(s=>s.type==='entry'||s.type==='add'))expect(s.time).toBeGreaterThan(30001+1800000);
  expect(()=>createEntryGate({...c,entrySignals:undefined})).toThrow('信号');
  expect(()=>createEntryGate({...c,minimumSignalAgeMinutes:-1})).toThrow('0–1440');
 });
 it('warms indicators without spending cash or consuming the single entry, then enters after discovery',()=>{
  const c=configuration();c.positionConfig.allowReentry=false;c.entrySignals=c.symbols.map(s=>({...s,signalTime:1200000}));
  const r=execute(c,true);expect(r.trades.length).toBeGreaterThan(0);
  for(const s of r.signals.filter(s=>s.type==='entry'||s.type==='add')){expect(s.time).toBeGreaterThan(1200000);expect((s.reason.monitoringSignal as any).signalTime).toBe(1200000);}
  const e=new ResumableEngine(c);for(const bar of normalizeCandles(candles(40),c.interval).candles)e.step(c.symbols.map(symbol=>({symbol,candle:bar,last:false})));
  expect(e.s.cash).toBe(c.executionConfig.initialCapital);expect(e.drain().signals).toEqual([]);expect(e.s.states.every(s=>!s.traded&&!s.entryWasMet&&s.highPivots.length>0)).toBe(true);
 });
 it('matches reference replay and checkpoint restore including adds and different CA times',()=>{
  const c=configuration();c.entrySignals=c.symbols.map((s,i)=>({...s,signalTime:1200000+i*300000}));
  const r=execute(c);expect(execute(c,true).report).toEqual(r.report);expect(execute(c,true).signals).toEqual(r.signals);
  const ref=runBacktest(c,c.symbols.map(symbol=>({symbol,candles:candles(250)})));
  expect(r.trades.map(t=>[t.entryTime,t.exitTime,t.netPnl])).toEqual(ref.trades.map(t=>[t.entryTime,t.exitTime,t.netPnl]));
  expect(r.report.maxDrawdown).toBe(ref.report.maxDrawdown);
 });
 it('does not invent an entry when the signal is at/after the last candle',()=>{
  const c=configuration();c.entrySignals=c.symbols.map(s=>({...s,signalTime:249*30000}));const r=execute(c);
  expect(r.signals).toEqual([]);expect(r.report.netPnl).toBe(0);expect(r.report.finalEquity).toBe(c.executionConfig.initialCapital);
 });
 it('migrates portfolio-4 checkpoints only for ungated configurations',()=>{
  const c=configuration(),e=new ResumableEngine(c),cp=e.checkpoint();cp.version=3;cp.engineVersion='portfolio-4';
  expect(new ResumableEngine(c,cp).s.version).toBe(CHECKPOINT_VERSION);
  c.entrySignals=c.symbols.map(s=>({...s,signalTime:10}));expect(()=>new ResumableEngine(c,cp)).toThrow('不兼容');
 });
});
