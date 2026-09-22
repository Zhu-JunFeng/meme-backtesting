import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {AppService} from '../src/main.js';
import {rerun} from '@meme/runtime';
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('immutable version descriptions and task snapshots',()=>{
 let pool:Pool,service:AppService,legacy:any,template:any,v1:any;
 const ca=randomUUID(),queue:any={add:async()=>{}};
 beforeAll(async()=>{
  if(!new URL(url!).pathname.includes('test'))throw Error('Only explicit test database');
  pool=new Pool({connectionString:url});
  await pool.query(readFileSync(new URL('../migrations/009_version_descriptions.sql',import.meta.url),'utf8'));
  service=Object.create(AppService.prototype);Object.defineProperty(service,'pool',{value:pool});Object.defineProperty(service,'queue',{value:queue});
  legacy=(await pool.query('SELECT * FROM backtest_strategy_versions WHERE description_json IS NULL ORDER BY created_at LIMIT 1')).rows[0];
  expect(legacy).toBeTruthy();
  template=await service.createTemplate({name:'description-test-'+ca,strategyJson:legacy.strategy_json,notes:'第一版备注 <script>not executed</script>'});
  v1=await service.version(template.currentVersionId);
  await pool.query("INSERT INTO meme_kline(chain,ca,pair_id,interval,type,open_time,close_time,open,high,low,close,volume,valid) VALUES('sol',$1,$1,'30s','mcap',30000,60000,1,2,1,2,1,true)",[ca]);
  await pool.query("INSERT INTO token_info(chain,ca,pair,signal_time) VALUES('sol',$1,$1,15000)",[ca]);
 });
 afterAll(async()=>{await pool?.end();});
 it('leaves old descriptions empty; generates new versions and rejects metadata edits',async()=>{
  expect((await service.version(legacy.id)).versionDescription).toBeNull();
  expect(v1.versionDescription.notes).toContain('第一版备注');expect(v1.versionDescription.generatedText).toContain('首次入场');
  await expect(pool.query("UPDATE backtest_strategy_versions SET description_json='{}' WHERE id=$1",[v1.id])).rejects.toThrow('不可变');
  await expect(pool.query('DELETE FROM backtest_strategy_versions WHERE id=$1',[v1.id])).rejects.toThrow('不可变');
  const v2=await service.createVersion(template.id,v1.strategyJson,'第二版备注');
  expect(v2.version).toBe(2);expect(v2.checksum).toBe(v1.checksum);expect((await service.version(v1.id)).versionDescription).toEqual(v1.versionDescription);
  expect((await service.versions(template.id))[0].versionDescription.notes).toBe('第二版备注');
 });
 it('clones old and new versions into independently described versions',async()=>{
  for(const source of [legacy.id,v1.id]){
   const clone=await service.cloneVersion(source,{name:'clone-'+randomUUID()});const v=await service.version(clone.currentVersionId);
   expect(v.versionDescription.generatedText).toContain('监控与回放');expect(v.id).not.toBe(source);
   expect(v.versionDescription.notes).toBe(source===legacy.id?'':v1.versionDescription.notes);
  }
 });
 it('freezes prose and runtime overrides separately from the engine config and preserves them on rerun',async()=>{
  const request={name:'snapshot-test',strategyVersionId:v1.id,dataset:{cas:[{chain:'sol',ca}],interval:'30s' as const,valueType:'mcap' as const},executionOverrides:{feePercent:1.25}};
  const created=await service.createBacktest(request),run=await service.backtest(created.id);
  expect(run.strategy_description_json).toEqual({...v1.versionDescription,version:1,executionOverrides:{feePercent:1.25}});
  expect(run.config_json.executionConfig.feePercent).toBe(1.25);expect(run.config_json).not.toHaveProperty('versionDescription');
  await service.createVersion(template.id,{...v1.strategyJson,executionConfig:{...v1.strategyJson.executionConfig,feePercent:2}},'第三版');
  expect((await service.backtest(created.id)).strategy_description_json).toEqual(run.strategy_description_json);
  const repeated=await rerun(pool,queue,created.id,randomUUID()),copy=await service.backtest(repeated.id);
  expect(copy.strategy_description_json).toEqual(run.strategy_description_json);expect(copy.config_json).toEqual(run.config_json);
  const oldRun=await service.createBacktest({...request,strategyVersionId:legacy.id});expect((await service.backtest(oldRun.id)).strategy_description_json).toBeNull();
 });
 it('rejects invalid notes atomically',async()=>{
  const before=(await service.versions(template.id)).length;
  await expect(service.createVersion(template.id,v1.strategyJson,{} as any)).rejects.toThrow('备注');
  expect((await service.versions(template.id)).length).toBe(before);
 });
});
