import {describe,it,expect} from 'vitest';
import {parseRoute,workspaceUrl} from './navigation';
describe('实时策略独立页面',()=>{
 it('supports refreshable detail and create addresses for both modes',()=>{
  const id='0f7fd932-9a0b-4eff-bdf2-c152e2788fcf';
  for(const page of ['paper','live'] as const){
   expect(parseRoute(workspaceUrl(page,'runs',id))).toEqual({page,tab:'runs',runId:id});
   expect(parseRoute(workspaceUrl(page,'create'))).toEqual({page,tab:'create'});
   expect(parseRoute(workspaceUrl(page))).toEqual({page,tab:'runs'});
  }
 });
 it('rejects malformed IDs and unknown pages without interpolating a request path',()=>{
  expect(parseRoute('#/paper/runs/../live')).toEqual({page:'paper',tab:'runs'});
  expect(parseRoute('#/unknown')).toEqual({page:'backtest',tab:'runs'});
 });
});
