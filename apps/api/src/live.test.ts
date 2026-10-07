import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomBytes,scryptSync} from 'node:crypto';
import {LiveController,requireLiveAdmin,validateRisk,validLiveSignalSource,resolveSignalSource} from './live.js';
import {liveSignalSources} from '@meme/domain';

const previousHash=process.env.LIVE_ADMIN_PASSWORD_HASH;
const previousMode=process.env.NODE_ENV;
afterEach(()=>{
 if(previousHash===undefined)delete process.env.LIVE_ADMIN_PASSWORD_HASH;else process.env.LIVE_ADMIN_PASSWORD_HASH=previousHash;
 if(previousMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousMode;
});

describe('live order safety boundaries',()=>{
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
  expect(query.mock.calls[1]).toEqual([expect.stringContaining("status IN ('paused','running')"),['r','all']]);
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
