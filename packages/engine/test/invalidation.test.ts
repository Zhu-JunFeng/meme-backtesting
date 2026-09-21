import { describe,it,expect } from 'vitest';
import { describeInvalidation } from '../src/index.js';
import type { Candle,ConditionGroup } from '@meme/domain';
const impulse={low:100,high:300,lowIndex:0,highIndex:1,confirmedAtIndex:2,gainPercent:200,averageVolume:10};
const candle=(close:number,open=close,volume=10):Candle=>({time:0,open,close,high:Math.max(open,close),low:Math.min(open,close),volume});
const fib={type:'break_fib_invalidation',ratio:.886,bufferPercent:2} as const;
const low={type:'break_swing_low_invalidation',bufferPercent:2} as const;
const bearish={type:'bearish_volume_invalidation',period:10,minRatio:2,minBodyPercent:20} as const;
describe('exit evidence without changing matching',()=>{
 it('records exact buffered Fib level and all matching reasons in config order',()=>{
  const d=describeInvalidation({mode:'any',conditions:[fib,low]},[candle(90)],impulse);
  expect(d.primary).toBe(fib.type);expect(d.matches.map(m=>m.code)).toEqual([fib.type,low.type]);expect(d.matches[0].thresholds.fibLevel).toBeCloseTo(122.8);expect(d.matches[0].thresholds.closeBelow).toBeCloseTo(120.344);
 });
 it('uses strict below and respects disabled leaves and failed nested branches',()=>{
  const group:ConditionGroup={mode:'any',conditions:[{mode:'all',conditions:[fib,{...low,bufferPercent:90}]},{...low,enabled:false},bearish]};
  const d=describeInvalidation(group,[candle(100),candle(100,130,20)],impulse);
  expect(d.matches.map(m=>m.code)).toEqual([bearish.type]);expect(d.matches[0].path).toEqual([2]);
  expect(describeInvalidation({mode:'all',conditions:[{...low,bufferPercent:0}]},[candle(100)],impulse).primary).toBe('unknown');
 });
 it('records bearish thresholds and does not infer loss from a bearish exit',()=>{
  const d=describeInvalidation({mode:'at_least',minMatches:1,conditions:[bearish]},[candle(100),candle(160,200,20)],impulse);
  expect(d.primary).toBe(bearish.type);expect(d.matches[0].observed).toMatchObject({close:160,bodyPercent:20,baselineVolume:10,volume:20});expect(d.matches[0].thresholds).toEqual({minBodyPercent:20,minVolume:20});
 });
 it('returns unavailable for unmet groups instead of claiming individual matches triggered them',()=>{
  const d=describeInvalidation({mode:'at_least',minMatches:2,conditions:[fib,low]},[candle(110)],impulse);expect(d.source).toBe('unavailable');expect(d.matches).toEqual([]);
 });
});
