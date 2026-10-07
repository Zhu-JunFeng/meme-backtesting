import {describe,expect,it} from 'vitest';
import {monitoringRows,runSourceText,sourceText} from './live-monitor';
const watches=[
 {ca:'old',pair_id:'pool1',created_at:'2026-10-01T01:00:00Z',signal_time:999999,status:'recovering',signal_source:'top_cluster_first_buy'},
 {ca:'new',pair_id:'pool2',created_at:'2026-10-02T01:00:00Z',signal_time:1,status:'monitoring',signal_source:'fomo_new_project_expanded'},
 {ca:'gone',pair_id:'pool3',created_at:'2026-10-03T01:00:00Z',status:'evicted_low_mcap',signal_source:'top_cluster_first_buy'},
 {ca:'held',pair_id:'pool4',created_at:'2026-10-03T01:00:00Z',status:'pending_eviction',signal_source:'top_cluster_first_buy'},
];
describe('live monitoring presentation',()=>{
 it('sorts by real admission time, not external signal time, without mutating polling data',()=>{
  expect(monitoringRows(watches,'',undefined,'desc').map(x=>x.ca)).toEqual(['held','new','old']);
  expect(monitoringRows(watches,'',undefined,'asc').map(x=>x.ca)).toEqual(['old','new','held']);
  expect(watches[0].ca).toBe('old');
 });
 it('combines source and address/pool filters and handles empty lists',()=>{
  expect(monitoringRows(watches,' POOL1 ','top_cluster_first_buy','asc').map(x=>x.ca)).toEqual(['old']);
  expect(monitoringRows(watches,'new','top_cluster_first_buy','asc')).toEqual([]);
  expect(monitoringRows([],'',undefined,'desc')).toEqual([]);
 });
 it('labels legacy all and explicit multi-selections without mislabeling unknown sources',()=>{
  expect(runSourceText({signal_source:'all'})).toBe('FOMO 新项目（扩大信号）、Top Cluster 首次买入');
  expect(runSourceText({signalSources:['top_cluster_first_buy']})).toBe('Top Cluster 首次买入');
  expect(sourceText('unknown')).toBe('未知来源');
 });
});
