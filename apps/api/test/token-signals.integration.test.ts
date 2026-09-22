import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolveSignalDataset,externalSignalsForRun} from '../src/token-signals.js';
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('external signal dataset and immutable display',()=>{
 let pool:Pool;const a=randomUUID(),b=randomUUID();
 beforeAll(async()=>{
  if(!new URL(url!).pathname.includes('test'))throw Error('Only test database');
  pool=new Pool({connectionString:url});await pool.query(readFileSync(new URL('../migrations/008_token_signals.sql',import.meta.url),'utf8'));
  for(const [ca,pair] of [[a,'p1'],[a,'p2'],[b,'p3']]){
   await pool.query("INSERT INTO meme_kline(chain,ca,pair_id,interval,type,open_time,close_time,open,high,low,close,volume,valid) VALUES('sol',$1,$2,'30s','mcap',30000,60000,1,2,1,2,1,true)",[ca,pair]);
   await pool.query("INSERT INTO token_info(chain,ca,pair,signal_time) VALUES('sol',$1,$2,$3)",[ca,pair,ca===a?15001:null]);
  }
  for(const [id,time] of [['first',15001],['later',31001]])await pool.query("INSERT INTO token_signal_events(chain,ca,signal_source,detail_id,signal_time,source_signal) VALUES('sol',$1,'fomo_new_project',$2,$3,'{}')",[a,id,time]);
 });
 afterAll(async()=>{if(pool){for(const table of ['token_info','token_signal_events','meme_kline'])await pool.query(`DELETE FROM ${table} WHERE chain='sol' AND ca=ANY($1::text[])`,[[a,b]]);await pool.end();}});
 const input=()=>({cas:[{chain:'sol',ca:a},{chain:'sol',ca:b}],interval:'30s' as const,valueType:'mcap' as const});
 it('excludes missing CA across pools and freezes all events, with earliest gate',async()=>{
  const d=await resolveSignalDataset(pool,input(),true);expect(d.symbols).toHaveLength(2);expect(d.entrySignals).toEqual([{chain:'sol',ca:a,signalTime:15001}]);expect(d.externalSignals).toHaveLength(2);expect(d.signalSelection?.excluded).toEqual([{chain:'sol',ca:b}]);
  const result=await externalSignalsForRun(pool,{config_json:d},{chain:'sol',ca:a,pairId:'p2',includeEndOfBacktest:'false',signalTypes:'stop_loss'});expect(result.total).toBe(2);expect(result.items[0]).toMatchObject({first:true,basis:'snapshot'});
  expect((await externalSignalsForRun(pool,{config_json:d},{pairId:'wrong'})).total).toBe(0);
  await pool.query("UPDATE token_signal_events SET signal_time=signal_time+100 WHERE ca=$1",[a]);
  expect((await externalSignalsForRun(pool,{config_json:d},{})).items[0].signalTime).toBe(15001);
  await pool.query("UPDATE token_signal_events SET signal_time=signal_time-100 WHERE ca=$1",[a]);
 });
 it('disabled gate keeps missing projects and display evidence without buy restriction',async()=>{const d=await resolveSignalDataset(pool,input(),false);expect(d.symbols).toHaveLength(3);expect(d.entrySignals).toBeUndefined();expect(d.externalSignals).toHaveLength(2);});
 it('fails closed on all missing signals, forged client gates and invalid settings',async()=>{
  await expect(resolveSignalDataset(pool,{...input(),cas:[{chain:'sol',ca:b}]},true)).rejects.toThrow('全部缺少');
  await expect(resolveSignalDataset(pool,{...input(),entrySignals:[{chain:'sol',ca:a,signalTime:0}]},true)).rejects.toThrow('不一致');
  await expect(resolveSignalDataset(pool,input(),'false' as any)).rejects.toThrow('布尔值');
 });
 it('legacy snapshots retain gate evidence and label later supplemental signals',async()=>{
  const run={config_json:{symbols:[{chain:'sol',ca:a,pairId:'p1'}],entrySignals:[{chain:'sol',ca:a,signalTime:15001}]}};
  const r=await externalSignalsForRun(pool,run,{});expect(r.items.map(e=>e.basis)).toEqual(['legacy_gate','supplemental']);
  expect((await externalSignalsForRun(pool,{config_json:{...run.config_json,externalSignals:[]}},{})).total).toBe(0);
 });
 it('signals beyond dataset end never authorize an earlier buy',async()=>{
  await pool.query('UPDATE token_info SET signal_time=90000 WHERE ca=$1',[a]);
  try{const d=await resolveSignalDataset(pool,input(),true);expect(d.signalSelection?.noOpportunity).toHaveLength(2);expect(d.entrySignals?.[0].signalTime).toBe(90000);}finally{await pool.query('UPDATE token_info SET signal_time=15001 WHERE ca=$1',[a]);}
 });
});
