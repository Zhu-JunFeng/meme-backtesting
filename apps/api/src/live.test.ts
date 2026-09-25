import {afterEach,describe,expect,it} from 'vitest';
import {randomBytes,scryptSync} from 'node:crypto';
import {requireLiveAdmin,validateRisk,validLiveSignalSource} from './live.js';

const previousHash=process.env.LIVE_ADMIN_PASSWORD_HASH;
const previousMode=process.env.NODE_ENV;
afterEach(()=>{
 if(previousHash===undefined)delete process.env.LIVE_ADMIN_PASSWORD_HASH;else process.env.LIVE_ADMIN_PASSWORD_HASH=previousHash;
 if(previousMode===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousMode;
});

describe('live order safety boundaries',()=>{
 it('accepts only the two configured signal sources and legacy all',()=>{
  expect(validLiveSignalSource('top_cluster_first_buy')).toBe(true);
  expect(validLiveSignalSource('fomo_new_project_expanded')).toBe(true);
  expect(validLiveSignalSource('all')).toBe(true);
  expect(validLiveSignalSource('fomo_new_project')).toBe(false);
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
