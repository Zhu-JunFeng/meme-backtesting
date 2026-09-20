import {describe,it,expect} from 'vitest';
import {marketValue,changePercent,duration} from '../src/format';
describe('chart presentation',()=>{
 it('formats market cap in K/M without changing price data',()=>{expect(marketValue(999)).toBe('999.00');expect(marketValue(1000)).toBe('1.00K');expect(marketValue(12500)).toBe('12.50K');expect(marketValue(1000000)).toBe('1.00M');expect(marketValue(1e9)).toBe('1000.00M');});
 it('compares cursor price against the selected buy, never weighted average',()=>{expect(changePercent(150,100)).toBe(50);expect(changePercent(80,100)).toBeCloseTo(-20);expect(changePercent(150,0)).toBeNull();expect(changePercent(NaN,100)).toBeNull();});
 it('shows elapsed wall-clock holding duration and unknown states',()=>{expect(duration(90061000)).toBe('1天 1小时 1分 1秒');expect(duration(null)).toBe('不可用');expect(duration(0)).toBe('0秒');});
});
