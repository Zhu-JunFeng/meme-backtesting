import {describe,it,expect} from 'vitest';
import {realizedCapital,sampleCapital} from './live-capital.js';
describe('资金曲线展示口径',()=>{
 it('groups simultaneous closes and excludes open positions',()=>{
  expect(realizedCapital(100,0,[{sellTime:2,realizedPnl:-20},{sellTime:1,realizedPnl:5},{sellTime:1,realizedPnl:2},{sellTime:null,realizedPnl:999}])).toEqual({total:3,points:[{time:0,equity:100},{time:1,equity:107},{time:2,equity:87}]});
 });
 it('does not invent zero-trade data',()=>{expect(realizedCapital(100,0,[])).toEqual({total:0,points:[]});});
 it('covers full lifetime, retains extrema and bounds payload size',()=>{
  const raw=Array.from({length:12000},(_,time)=>({time,equity:time===100?0:time===11000?99999:100}));
  const points=sampleCapital(raw);
  expect(points.length).toBeLessThanOrEqual(1800);
  expect(points[0]).toEqual(raw[0]);expect(points.at(-1)).toEqual(raw.at(-1));
  expect(points.some(x=>x.equity===0)).toBe(true);expect(points.some(x=>x.equity===99999)).toBe(true);
 });
});
