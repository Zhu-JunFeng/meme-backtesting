import {describe,it,expect} from 'vitest';
import {capitalGeometry} from './capital-chart';
describe('capital chart',()=>{
 it('uses steps for realized balances and includes the initial baseline',()=>{
  const g=capitalGeometry([{time:1,equity:100},{time:2,equity:110}],90,330,true);
  expect(g.path).toContain('H');expect(g.path).toContain('V');expect(g.y(90)).toBeLessThan(g.bottom);
  expect(g.x(1)).toBe(g.left);expect(g.x(2)).toBe(g.right);
 });
 it('renders flat and singleton curves without NaN and keeps negative balances',()=>{
  for(const points of [[{time:1,equity:0}],[{time:1,equity:-10},{time:2,equity:-10}]]){
   const g=capitalGeometry(points,0,280,false);expect(g.path).not.toMatch(/NaN|Infinity/);expect(g.path).not.toContain('H');
  }
 });
});
