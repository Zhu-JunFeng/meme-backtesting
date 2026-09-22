import {it,expect} from 'vitest';
import {externalBuckets} from '../src/externalSignals';
it.each([30000,60000])('buckets subsecond signals without changing true time or inventing prices (%s)',step=>{
 const events=[{id:'a',signalTime:step+1,first:true},{id:'b',signalTime:step+1234},{id:'future',signalTime:step*3},{id:'missing',signalTime:1}];
 const b=externalBuckets(events,step,new Set([step]),{from:0,to:step*4/1000});expect(b).toHaveLength(1);expect(b[0].events).toHaveLength(2);expect(b[0].events[0].signalTime).toBe(step+1);expect(b[0].label).toBe('首次监控 ×2');expect(b[0]).not.toHaveProperty('price');
 expect(externalBuckets(events,step,new Set(),{from:0,to:step*4/1000})).toHaveLength(0);
 expect(externalBuckets(events,step,new Set([step]),{from:step*2/1000,to:step*4/1000})).toHaveLength(0);
});
