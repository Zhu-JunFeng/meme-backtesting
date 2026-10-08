import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomBytes,scryptSync} from 'node:crypto';
import {LiveController,requireLiveAdmin,validateRisk,validLiveSignalSource,resolveSignalSource,resolveSignalSources} from './live.js';
import {liveSignalSources} from '@meme/domain';

const previousHash=process.env.LIVE_ADMIN_PASSWORD_HASH;
const previousMode=process.env.NODE_ENV;
afterEach(()=>{
 if(previousHash===undefined)delete process.env.LIVE_ADMIN_PASSWORD_HASH;else process.env.LIVE_ADMIN_PASSWORD_HASH=previousHash;
 if(previousMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousMode;
});

describe('live order safety boundaries',()=>{
 it('pages the overview and computes the same closed-trade performance without N+1 queries',async()=>{
  const controller=new LiveController();
  const run={id:'00000000-0000-0000-0000-000000000001',name:'策略 A',mode:'paper',chain:'sol',interval:'30s',value_type:'mcap',signal_source:'all',status:'running',strategy_json:{},wallet_address:null,risk_json:null,active_ca_count:2};
  const fill=(id:string,side:'buy'|'sell',gross:number,time:number)=>({run_id:run.id,id,position_id:'position-1',chain:'sol',ca:'CA',pair_id:'pair',side,reason:side==='buy'?'entry':'take_profit',decision_time:time,fill_time:time,fill_value:100,fill_price:1,market_cap:100,quantity:1,gross_amount:gross,fee:0,slippage_cost:0,tax_cost:0});
  const query=vi.spyOn((controller as any).pool,'query')
   .mockResolvedValueOnce({rows:[{all:3,running:1,paused:1,stopped:1}]})
   .mockResolvedValueOnce({rows:[run]})
   .mockResolvedValueOnce({rows:[fill('buy','buy',10,1000),fill('sell','sell',15,2000)]})
   .mockResolvedValueOnce({rows:[]});
  const result=await controller.overview({mode:'paper',status:'running',page:'1',pageSize:'12'});
  expect(result).toMatchObject({total:1,counts:{all:3,running:1},items:[{performance:{openCount:0,closedCount:1,winRate:100,realizedPnl:5}}]});
  expect(result.items[0]).not.toHaveProperty('strategy_json');
  expect(query).toHaveBeenCalledTimes(4);
  expect(query.mock.calls[1][1]).toEqual(['paper','running',12,0]);
  await controller.onModuleDestroy();
 });
 it('keeps zero-trade overview rates unavailable and rejects invalid paging',async()=>{
  const controller=new LiveController();
  const query=vi.spyOn((controller as any).pool,'query')
   .mockResolvedValueOnce({rows:[{all:1,running:0,paused:1,stopped:0}]})
   .mockResolvedValueOnce({rows:[{id:'00000000-0000-0000-0000-000000000002',mode:'paper',interval:'1m',value_type:'price',status:'paused',signal_source:'all',strategy_json:{}}]})
   .mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[]});
  const result=await controller.overview({mode:'paper',status:'paused'});
  expect(result.items[0].performance).toMatchObject({closedCount:0,winRate:null,realizedPnl:0});
  await expect(controller.overview({status:'unknown'})).rejects.toThrow('任务状态无效');
  await expect(controller.overview({pageSize:'300'})).rejects.toThrow('分页参数无效');
  expect(query).toHaveBeenCalledTimes(4);
  await controller.onModuleDestroy();
 });
 it('normalizes multi-source selections without changing legacy callers',()=>{
  expect(resolveSignalSource({})).toBe('all');
  expect(resolveSignalSource({signalSource:'top_cluster_first_buy'})).toBe('top_cluster_first_buy');
  expect(resolveSignalSource({signalSources:['top_cluster_first_buy','fomo_new_project_expanded','top_cluster_first_buy']})).toBe('all');
  expect(resolveSignalSource({signalSources:['top_cluster_first_buy','top_cluster_first_buy']})).toBe('top_cluster_first_buy');
  expect(liveSignalSources('all')).toEqual(['fomo_new_project_expanded','top_cluster_first_buy']);
  for(const values of [[],null,'all',['all'],['unknown']])expect(()=>resolveSignalSource({signalSources:values})).toThrow();
  expect(()=>resolveSignalSource({signalSource:'all',signalSources:['top_cluster_first_buy']})).toThrow();
 });
 it('updates paper admission sources only, leaving watches and funds untouched',async()=>{
  const controller=new LiveController();
  const query=vi.spyOn((controller as any).pool,'query').mockResolvedValueOnce({rows:[{mode:'paper'}]}).mockResolvedValueOnce({rowCount:1,rows:[{id:'r',mode:'paper',signal_source:'all',wallet_address:null}]});
  expect(await controller.sources('r',{signalSources:['top_cluster_first_buy','fomo_new_project_expanded']},'',{})).toMatchObject({id:'r',signalSources:['fomo_new_project_expanded','top_cluster_first_buy']});
  expect(query.mock.calls[1]).toEqual([expect.stringContaining("status IN ('paused','running')"),['r','all',['fomo_new_project_expanded','top_cluster_first_buy']]]);
  expect(query.mock.calls.every(call=>!String(call[0]).includes('live_watches'))).toBe(true);
  await controller.onModuleDestroy();
 });
 it('refuses source writes to live tasks without administrator authorization',async()=>{
  delete process.env.LIVE_ADMIN_PASSWORD_HASH;
  const controller=new LiveController();const query=vi.spyOn((controller as any).pool,'query').mockResolvedValue({rows:[{mode:'live'}]});
  await expect(controller.sources('r',{signalSources:['top_cluster_first_buy']},'',{})).rejects.toThrow();
  expect(query).toHaveBeenCalledTimes(1);await controller.onModuleDestroy();
 });
 it('refuses source edits for a stopped task',async()=>{
  const controller=new LiveController();vi.spyOn((controller as any).pool,'query').mockResolvedValueOnce({rows:[{mode:'paper'}]}).mockResolvedValueOnce({rowCount:0,rows:[]});
  await expect(controller.sources('r',{signalSources:['top_cluster_first_buy']},'',{})).rejects.toThrow('已停止');await controller.onModuleDestroy();
 });
 it('accepts only the two configured signal sources and legacy all',()=>{
  expect(validLiveSignalSource('top_cluster_first_buy')).toBe(true);
  expect(validLiveSignalSource('fomo_new_project_expanded')).toBe(true);
  expect(validLiveSignalSource('all')).toBe(true);
  expect(validLiveSignalSource('fomo_new_project')).toBe(false);
  expect(validLiveSignalSource(['all'])).toBe(false);
  expect(validLiveSignalSource('fomo_trending_new_project')).toBe(true);
 });
 it('persists arbitrary subsets without expanding old all tasks',()=>{
  expect(resolveSignalSources({signalSource:'all'})).toEqual(['fomo_new_project_expanded','top_cluster_first_buy']);
  expect(resolveSignalSources({signalSources:['fomo_trending_new_project','top_cluster_first_buy']})).toEqual(['top_cluster_first_buy','fomo_trending_new_project']);
  expect(()=>resolveSignalSources({signalSource:'all',signalSources:['top_cluster_first_buy','fomo_trending_new_project']})).toThrow();
 });
 it('returns and writes the exact multi-selection, not the legacy all summary',async()=>{
  const c=new LiveController(),sources=['top_cluster_first_buy','fomo_trending_new_project'];
  const q=vi.spyOn((c as any).pool,'query').mockResolvedValueOnce({rows:[{mode:'paper'}]}).mockResolvedValueOnce({rowCount:1,rows:[{mode:'paper',signal_source:'all',signal_sources:sources}]});
  expect(await c.sources('r',{signalSources:[...sources].reverse()},'',{})).toMatchObject({signalSources:sources});
  expect(q.mock.calls[1][1]).toEqual(['r','all',sources]);await c.onModuleDestroy();
 });
 it('requires an administrator secret and HTTPS in production',()=>{
  const salt=randomBytes(16).toString('hex');
  process.env.LIVE_ADMIN_PASSWORD_HASH=`${salt}:${scryptSync('correct-password',salt,64).toString('hex')}`;
  process.env.NODE_ENV='production';
  const local={headers:{'x-forwarded-proto':'https'},socket:{remoteAddress:'127.0.0.1'}};
  expect(()=>requireLiveAdmin('correct-password',{...local,headers:{'x-forwarded-proto':'http'}})).toThrow();
  expect(()=>requireLiveAdmin('correct-password',{...local,socket:{remoteAddress:'203.0.113.1'}})).toThrow();
  expect(()=>requireLiveAdmin('wrong-password',local)).toThrow();
  expect(()=>requireLiveAdmin('correct-password',local)).not.toThrow();
 });
 it('rejects missing or inconsistent hard trading limits',()=>{
  expect(()=>validateRisk(undefined)).toThrow();
  expect(()=>validateRisk({maxOrderNative:2,maxTotalNative:1,maxDailyLossUsd:10,maxPositions:1,tip:0.001,slippagePercent:5})).toThrow();
  expect(()=>validateRisk({maxOrderNative:0.01,maxTotalNative:0.05,maxDailyLossUsd:10,maxPositions:1,tip:0.001,slippagePercent:5})).not.toThrow();
 });
});
