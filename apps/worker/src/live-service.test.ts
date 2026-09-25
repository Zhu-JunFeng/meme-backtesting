import {describe,expect,it} from 'vitest';
import {acceptsNewSignal} from './live-service.js';

describe('source-isolated paper runs',()=>{
 const signal={chain:'robin' as const,ca:'0x123',source:'top_cluster_first_buy' as const,time:2000,key:'signal-1',identity:{}};
 it('does not admit another source into the run',()=>{
  expect(acceptsNewSignal({signal_source:'fomo_new_project_expanded',started_at:new Date(1000)},signal)).toBe(false);
  expect(acceptsNewSignal({signal_source:'top_cluster_first_buy',started_at:new Date(1000)},signal)).toBe(true);
 });
 it('requires signal time strictly after task start',()=>{
  expect(acceptsNewSignal({signal_source:'top_cluster_first_buy',started_at:new Date(2000)},signal)).toBe(false);
  expect(acceptsNewSignal({signal_source:'top_cluster_first_buy',started_at:new Date(3000)},signal)).toBe(false);
 });
});
