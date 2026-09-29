import {describe,expect,it} from 'vitest';
import {decisionBucket,liveFib} from './live-locator.js';

const impulse={low:50,high:150,lowIndex:1,highIndex:4,confirmedAtIndex:6,lowTime:30_000,highTime:120_000,confirmedTime:180_000};
describe('live chart evidence',()=>{
 it('uses the saved entry impulse and never reselects later pivots',()=>{
  const fib=liveFib({entryConditionGroup:{mode:'all',conditions:[]}},impulse,210_000,300_000,[{label:'买1',fill_time:220_000,fill_value:88}]);
  expect(fib.status).toBe('available');
  if('low' in fib){
   expect(fib.low.time).toBe(30_000);expect(fib.high.value).toBe(150);
   expect(fib.levels.find(x=>x.ratio===.618)?.value).toBeCloseTo(88.2);
   expect(fib.buys[0].ratio).toBeCloseTo(.62);
  }
 });
 it('refuses missing or late-confirmed Fib anchors',()=>{
  expect(liveFib({},impulse,179_999,null,[]).status).toBe('unavailable');
  expect(liveFib({}, {...impulse,lowTime:undefined},210_000,null,[]).status).toBe('unavailable');
 });
 it('maps close decisions to the completed bar but intrabar exits to their own bucket',()=>{
  expect(decisionBucket(60_000,'entry',30_000)).toBe(30_000);
  expect(decisionBucket(60_000,'timeout',30_000)).toBe(30_000);
  expect(decisionBucket(60_000,'stop_loss',30_000)).toBe(60_000);
  expect(decisionBucket(90_000,'entry',60_000)).toBe(60_000);
 });
});
