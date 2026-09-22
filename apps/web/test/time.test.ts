import {it,expect} from 'vitest';
import {beijingTime,beijingInputToIso,DISPLAY_TIME_ZONE} from '../src/time';
it.each(['UTC','Asia/Shanghai','America/New_York'])('Beijing display and input are independent of host TZ %s',tz=>{
 const before=process.env.TZ;process.env.TZ=tz;
 try {
  expect(beijingTime('2026-09-21T23:59:59.123Z',true)).toBe('2026-09-22 07:59:59.123');
  expect(beijingTime(0)).toBe('1970-01-01 08:00:00');
  expect(beijingTime('0')).toBe(beijingTime(0));
  expect(beijingInputToIso('2026-09-22T00:30')).toBe('2026-09-21T16:30:00.000Z');
  expect(beijingInputToIso('2026-09-22T08:00:00.123')).toBe('2026-09-22T00:00:00.123Z');
 } finally {if(before===undefined)delete process.env.TZ;else process.env.TZ=before;}
});
it('rejects missing/invalid dates and does not silently normalize impossible input',()=>{
 for(const v of [null,undefined,'',NaN,Infinity,'wrong'])expect(beijingTime(v)).toBe('不可用');
 expect(beijingInputToIso('')).toBeUndefined();
 for(const v of ['2026-02-30T09:00','2026-09-22T25:00','2026-09-22','oops','2026-09-22T08:00Z'])expect(()=>beijingInputToIso(v)).toThrow();
 expect(DISPLAY_TIME_ZONE).toBe('Asia/Shanghai');
});
