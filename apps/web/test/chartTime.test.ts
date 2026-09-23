import {it,expect} from 'vitest';
import {chartTimeLabel,chartTimeFormatters} from '../src/chartTime';
it.each(['UTC','Asia/Shanghai','America/New_York'])('formats TradingView Beijing calendar dates without double offset in %s',tz=>{
 const original=process.env.TZ;process.env.TZ=tz;
 try {
  // Real candle instant 07:03Z is supplied by TradingView as Beijing calendar 15:03.
  const date=new Date('2026-09-23T15:03:30Z'),time=date.getTime();
  expect(chartTimeLabel(date)).toBe('周三 9/23 15:03');
  expect(chartTimeFormatters.dateFormatter.format(date)).toBe('周三 9/23');
  expect(chartTimeFormatters.timeFormatter.format(date)).toBe('15:03');
  expect(chartTimeFormatters.dateFormatter.formatLocal(date)).toBe('周三 9/23');
  expect(date.getTime()).toBe(time);
  expect(chartTimeLabel(new Date('2027-01-01T00:03:00Z'))).toBe('周五 1/1 00:03');
 }finally{if(original===undefined)delete process.env.TZ;else process.env.TZ=original;}
});
it('handles invalid dates and preserves unambiguous date dialog input',()=>{
 expect(chartTimeLabel(new Date(NaN))).toBe('—');
 expect(chartTimeFormatters.dateFormatter.parse('2026-09-23')).toBe('2026-09-23');
 expect(chartTimeFormatters.dateFormatter.parse('周三 9/23')).toBe('');
});
