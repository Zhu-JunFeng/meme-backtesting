import {describe,it,expect} from 'vitest';
import {partitionMarkers} from '../src/chartMarkers';
describe('exact candle marker anchors',()=>{
 it.each([30,60])('keeps both layers on loaded %s-second candles; never snaps future/gap events',step=>{
  const events=[{id:'buy1',time:0},{id:'sell1',time:step*1000},{id:'buy2',time:step*1000},{id:'gap',time:step*500},{id:'future',time:step*2000}];
  const loaded=new Set([0,step*1000]);
  let x=partitionMarkers(events,loaded,{from:0,to:step});
  expect(x.drawable.map(e=>e.id)).toEqual(['buy1','sell1','buy2']);expect(x.missing.map(e=>e.id)).toEqual(['gap']);
  x=partitionMarkers(events,loaded,{from:step,to:step*2});expect(x.drawable.map(e=>e.id)).toEqual(['sell1','buy2']);expect(x.missing.map(e=>e.id)).toEqual(['future']);
  loaded.add(step*2000);expect(partitionMarkers(events,loaded,{from:step*2,to:step*2}).drawable[0].id).toBe('future');
  loaded.clear();expect(partitionMarkers(events,loaded,{from:0,to:step*2}).drawable).toEqual([]);
 });
 it('does not round missing or subsecond event times onto a candle',()=>{
  expect(partitionMarkers([{time:30001},{time:NaN}],new Set([30000]),{from:0,to:60}).drawable).toEqual([]);
 });
});
