import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {LiveEvaluator,type ClosedMarketBar} from '@meme/engine';
import {defaultProjectSources,type StrategyConfig} from '@meme/domain';
import {LiveService,simulatedBarPrice,LIVE_EXECUTION_VERSION} from './live-service.js';
import {parseHistory} from './history-client.js';

const strategy:StrategyConfig={schemaVersion:1,entryAfterSignal:true,
 impulseCondition:{type:'impulse_fractal_swing',leftBars:1,rightBars:1,lookbackBars:30,minGainPercent:50,maxDurationBars:20,requireVolumeExpansion:false},
 entryConditionGroup:{mode:'all',conditions:[{type:'fib_retracement',zoneLow:.5,zoneHigh:.9}]},
 invalidationConditionGroup:{mode:'any',conditions:[{type:'break_swing_low_invalidation'}]},
 exitConfig:{stopLoss:{type:'percent',value:10},takeProfit:{type:'percent',value:50},closeAtEnd:false},
 positionConfig:{mode:'single_entry',maxEntries:1,maxConcurrentPositions:2,allowReentry:true,sizing:{type:'fixed_amount',value:10}},
 executionConfig:{initialCapital:100,feePercent:1,slippagePercent:1,buyTaxPercent:1,sellTaxPercent:1,fillMode:'current_bar_close'}};
const impulse={low:5,high:150,lowIndex:0,highIndex:1,confirmedAtIndex:2,gainPercent:2900,averageVolume:10};
const bar=(ca='a',type:'price'|'mcap'='price',time=180_000,close=95):ClosedMarketBar=>({symbol:{chain:'sol',ca,pairId:ca},interval:'30s',type,tradeCount:2,closeTradeId:'last',closeTradeTime:time+25_000,candle:{time,closeTime:time+30_000,open:100,high:101,low:85,close,volume:10,valid:true}});

describe('paired bar simulation',()=>{
 it('uses the same bucket price/mcap ratio, never a stale last tick',()=>{
  const price=bar(),mc={...bar('a','mcap'),candle:{...bar().candle,open:10000,high:10100,low:8500,close:9500}};
  expect(simulatedBarPrice('mcap',9000,mc,price)).toBe(90);
  expect(simulatedBarPrice('price',90,price,price)).toBe(90);
  expect(simulatedBarPrice('mcap',9000,mc,{...price,closeTradeId:'different'})).toBeUndefined();
  expect(simulatedBarPrice('mcap',9000,mc,undefined)).toBeUndefined();
  expect(simulatedBarPrice('mcap',9000,mc,{...price,candle:{...price.candle,time:0}})).toBeUndefined();
 });
});

const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('closed-bar database integration (isolated schema, no real orders)',()=>{
 let pool:Pool,admin:Pool;const schema=`live_bar_test_${randomUUID().replaceAll('-','')}`;let version:string;
 beforeAll(async()=>{
  if(!new URL(url!).pathname.includes('test'))throw new Error('Explicit test database required');
  admin=new Pool({connectionString:url});await admin.query(`CREATE SCHEMA ${schema}`);
  pool=new Pool({connectionString:url,options:`-c search_path=${schema},public`});
  await pool.query('CREATE TABLE backtest_strategy_versions(id uuid PRIMARY KEY DEFAULT gen_random_uuid())');
  version=(await pool.query('INSERT INTO backtest_strategy_versions DEFAULT VALUES RETURNING id')).rows[0].id;
  for(const name of ['010_live_trading','011_live_signal_sources','012_live_watch_dex','013_live_recovery_capacity','014_live_portfolio','015_live_closed_bar','016_live_market_protocol','017_live_signal_selections','018_project_sources'])
   await pool.query(readFileSync(new URL(`../../api/migrations/${name}.sql`,import.meta.url),'utf8').replaceAll('public.',`${schema}.`));
  await pool.query(`CREATE TABLE meme_kline(chain text,ca text,pair_id text,interval text,open_time bigint,close_time bigint,open numeric,high numeric,low numeric,close numeric,volume numeric,trade_count bigint,type text,source text,raw_data jsonb,valid boolean,UNIQUE(chain,pair_id,interval,open_time,type))`);
  await pool.query(`CREATE TABLE token_signal_events(chain text,ca text,signal_source text,detail_id text,signal_time bigint,source_signal jsonb,provenance jsonb,UNIQUE(chain,ca,signal_source,detail_id));CREATE TABLE token_info(chain text,ca text,pair text,signal_source text,source_signal jsonb,signal_time bigint,UNIQUE(chain,ca,pair))`);
 },20_000);
 afterEach(()=>vi.unstubAllEnvs());
 afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
 async function fixture(mode='paper',valueType='price',cash=0){
  const run=(await pool.query(`INSERT INTO live_runs(name,mode,chain,interval,value_type,strategy_version_id,strategy_json,initial_capital,cash,status,wallet_address,risk_json)
    VALUES('test',$1,'sol','30s',$2,$3,$4,100,$5,'running',$6,$7) RETURNING *`,[mode,valueType,version,JSON.stringify(strategy),cash,mode==='live'?randomUUID():null,mode==='live'?JSON.stringify({maxOrderNative:1,maxTotalNative:10,maxDailyLossUsd:100,maxPositions:2,tip:.001,slippagePercent:1}):null])).rows[0];
  const service:any=new LiveService(pool);service.feedHealthy=true;
  const add=async(ca:string,held=true)=>{
   const watch=(await pool.query("INSERT INTO live_watches(run_id,chain,ca,pair_id,signal_source,signal_key,signal_time) VALUES($1,'sol',$2,$2,'test','signal',0) RETURNING *",[run.id,ca])).rows[0];
   const evaluator=new LiveEvaluator(strategy,0);
   for(const [i,v] of [10,9,10,20,18,17].entries())evaluator.onClosedCandle({time:i*30_000,closeTime:(i+1)*30_000,open:v,high:v,low:v,close:v,volume:10},true);
   if(held)evaluator.state.position={entryPrice:valueType==='mcap'?10000:100,quantity:1,entries:1,entryTime:150_000,entryBar:5,impulse,tradeNo:1,costBasisUsd:100};
   const ctx={run,watch,evaluator,ready:true,noOrdersBefore:0,nextRecoveryAt:0};
   service.watches.set(`${run.id}:sol:${ca}`,ctx);service.connected.add(`sol:${ca}`);return ctx;
  };
  return {run,service,add};
 }
 it('migrates legacy all to two explicit sources, keeps new subsets, and is repeatable',async()=>{
  const {run}=await fixture('paper','price',123);
  const sql=readFileSync(new URL('../../api/migrations/017_live_signal_selections.sql',import.meta.url),'utf8').replaceAll('public.',`${schema}.`);
  await pool.query(sql);
  let stored=(await pool.query('SELECT * FROM live_runs WHERE id=$1',[run.id])).rows[0];
  expect(stored.signal_sources).toEqual(['fomo_new_project_expanded','top_cluster_first_buy']);expect(stored.cash).toBe('123');expect(stored.strategy_json).toEqual(strategy);
  await pool.query('UPDATE live_runs SET signal_sources=$2 WHERE id=$1',[run.id,['top_cluster_first_buy','fomo_trending_new_project']]);
  await pool.query(sql);
  stored=(await pool.query('SELECT * FROM live_runs WHERE id=$1',[run.id])).rows[0];expect(stored.signal_sources).toEqual(['top_cluster_first_buy','fomo_trending_new_project']);
  await expect(pool.query('UPDATE live_runs SET signal_sources=$2 WHERE id=$1',[run.id,[]])).rejects.toThrow();
  await expect(pool.query('UPDATE live_runs SET signal_sources=$2 WHERE id=$1',[run.id,['unknown']])).rejects.toThrow();
 });
 it('admits multiple sources once, uses their minimum exit cap, and can re-admit an evicted feed CA',async()=>{
  const {run,service}=await fixture();const config=defaultProjectSources();config.wallet.enabled=config.xxyy.enabled=true;
  await pool.query('UPDATE live_runs SET started_at=now()-interval \'1 hour\',project_sources=$2 WHERE id=$1',[run.id,JSON.stringify(config)]);
  service.refresh=vi.fn();const now=Date.now(),facts={marketCap:80000,createdAt:now-100000,kol:3,dexId:'pfamm'},candidate={provider:'xxyy',observedAt:now,chain:'sol',ca:'multi',source:'xxyy_completed',key:'feed:1',time:now,facts,identity:{source:'xxyy_completed'}};
  await service.onSignal(candidate,{pairId:'p',dexId:'pfamm'});
  await service.onSignal({...candidate,key:'feed:2',time:now+1},{pairId:'p',dexId:'pfamm'});
  let watches=(await pool.query('SELECT * FROM live_watches WHERE run_id=$1',[run.id])).rows;
  expect(watches).toHaveLength(1);expect(watches[0].matched_sources).toEqual(['xxyy']);expect(watches[0].signal_key).toBe('feed:1');expect(watches[0].exit_market_cap).toBe('30000');
  expect((await pool.query("SELECT * FROM live_events WHERE run_id=$1 AND kind='external_signal'",[run.id])).rows).toHaveLength(1);
  await service.onSignal({...candidate,provider:'wallet',source:'wallet_buy',key:'wallet:1',identity:{source:'wallet_buy',transactionTime:now}},{pairId:'p',dexId:'pfamm'});
  watches=(await pool.query('SELECT * FROM live_watches WHERE run_id=$1',[run.id])).rows;expect(watches[0].exit_market_cap).toBe('20000');expect(watches[0].matched_sources).toEqual(['xxyy','wallet']);
  await pool.query("UPDATE live_watches SET status='evicted_low_mcap' WHERE run_id=$1",[run.id]);
  await service.onSignal({...candidate,key:'feed:3',time:now+2},{pairId:'p',dexId:'pfamm'});
  const restored=(await pool.query('SELECT * FROM live_watches WHERE run_id=$1',[run.id])).rows[0];expect(restored.signal_key).toBe('feed:3');expect(restored.status).toBe('recovering');expect(restored.matched_sources).toEqual(['xxyy']);
 });
 it('serializes concurrent last-slot admissions and retains held positions on eviction',async()=>{
  const {run,service,add}=await fixture();await pool.query("UPDATE live_runs SET started_at=now()-interval '1 hour' WHERE id=$1",[run.id]);service.refresh=vi.fn();
  for(let i=0;i<19;i++)await add(`capacity${i}`,false);
  const signal=(ca:string)=>({provider:'memeinfo',observedAt:Date.now(),chain:'sol',ca,source:'fomo_new_project_expanded',key:ca,time:Date.now(),facts:{marketCap:80000},identity:{source:'fomo_new_project_expanded'}});
  await Promise.all(['last1','last2'].map(ca=>service.onSignal(signal(ca),{pairId:ca,dexId:''})));
  expect(Number((await pool.query('SELECT count(*) FROM live_watches WHERE run_id=$1',[run.id])).rows[0].count)).toBe(20);
  const held=await add('held');await service.evictOrRetain(held,'below cap');expect(held.watch.status).toBe('pending_eviction');expect(held.evaluator.state.position).toBeDefined();
  await service.markRecovering(held,'test reconnect');expect(held.watch.exit_only).toBe(true);
  expect((await pool.query('SELECT exit_only FROM live_watches WHERE run_id=$1 AND ca=$2',[run.id,'held'])).rows[0].exit_only).toBe(true);
  held.ready=true;held.watch.status='monitoring';held.watch.current_mcap='999999';
  await service.createDecision(held,{side:'buy',reason:'pyramiding',time:180000,value:100},bar('held'),bar('held'));
  expect((await pool.query('SELECT id FROM live_orders WHERE run_id=$1 AND ca=$2',[run.id,'held'])).rows).toHaveLength(0);
  held.evaluator.state.position=undefined;await service.evictOrRetain(held,'closed');expect(held.watch.status).toBe('evicted_low_mcap');
 });
 it('imports history with exact decimals, retains authoritative conflicts, and never emits historical orders',async()=>{
  const {run,service,add}=await fixture('paper','mcap');const ctx=await add('history');ctx.evaluator.state.position!.lockPrice=10500;ctx.evaluator.state.position!.lockTier=1;
  const before=structuredClone(ctx.evaluator.state.position),time=210000;
  const result={endpoint:'https://history',traceId:'trace',rows:[{time,open:'12000.0000000000000001',high:'13000',low:'11000',close:'12500',volume:'1.1234567890123456789'}]};
  await service.applyHistory(ctx,[{type:'mcap',result},{type:'price',result:{...result,rows:result.rows.map(r=>({...r,open:'120',high:'130',low:'110',close:'125'}))}}],()=>true);
  expect(ctx.evaluator.state.position).toEqual(before);expect(ctx.evaluator.state.lastCandleTime).toBe(time);
  const stored=(await pool.query("SELECT * FROM meme_kline WHERE ca='history' AND type='mcap'")).rows[0];expect(stored.open).toBe('12000.0000000000000001');expect(stored.volume).toBe('1.1234567890123456789');expect(stored.source).toBe('memeinfo_xxyy');expect(stored.raw_data.traceId).toBe('trace');
  await service.applyHistory(ctx,[{type:'mcap',result:{...result,rows:result.rows.map(r=>({...r,close:'12000'}))}}],()=>true);
  expect(ctx.evaluator.state.history.at(-1)!.close).toBe(12500);expect((await pool.query('SELECT count(*) n FROM live_orders WHERE run_id=$1',[run.id])).rows[0].n).toBe('0');
 });
 it('stores valid history after dropping bad rows, audits once and preserves positions without replaying orders',async()=>{
  const {run,service,add}=await fixture();const ctx=await add('drop-history'),before=structuredClone(ctx.evaluator.state.position);
  const request={chain:'sol',pair:'drop-history',interval:'30s' as const,type:'price' as const,from:180000,to:270000};
  const items=[180000,210000,240000].map(start_time=>({start_time,open:'10',high:'12',low:'9',close:'11',volume:'1'}));items[1].open='20';
  const result=parseHistory({success:true,code:'200',traceId:'bad-row',data:{chain:'sol',pair_address:request.pair,interval:'30s',value_type:'price',items}},request,'history');
  await service.applyHistory(ctx,[{type:'price',result}],()=>true);
  await service.applyHistory(ctx,[{type:'price',result:{...result,traceId:'retry'}}],()=>true);
  expect((await pool.query("SELECT open_time FROM meme_kline WHERE ca='drop-history' ORDER BY open_time")).rows.map(r=>Number(r.open_time))).toEqual([180000,240000]);
  expect(ctx.evaluator.state.lastCandleTime).toBe(240000);expect(ctx.evaluator.state.position).toEqual(before);
  expect((await pool.query('SELECT count(*) n FROM live_orders WHERE run_id=$1',[run.id])).rows[0].n).toBe('0');
  const events=(await pool.query("SELECT payload FROM live_events WHERE run_id=$1 AND kind='history_candles_discarded'",[run.id])).rows;
  expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({discarded:1,retained:2,traceId:'bad-row'});
 });
 it('rolls back history and checkpoint when the recovery epoch is lost during storage',async()=>{
  const {run,service,add}=await fixture();const ctx=await add('stale-history'),before=ctx.evaluator.snapshot();let valid=true;
  const connect=pool.connect.bind(pool);service.pool={query:pool.query.bind(pool),connect:async()=>{const client=await connect();return new Proxy(client,{get(target,key){if(key==='query')return async(sql:string,args:any[])=>{const result=await target.query(sql,args);if(sql.startsWith('INSERT INTO meme_kline'))valid=false;return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}};
  await service.applyHistory(ctx,[{type:'price',result:{endpoint:'history',rows:[{time:210000,open:'1',high:'1',low:'1',close:'1',volume:'1'}]}}],()=>valid);
  expect(ctx.evaluator.snapshot()).toEqual(before);expect((await pool.query("SELECT count(*) n FROM meme_kline WHERE ca='stale-history'")).rows[0].n).toBe('0');expect((await pool.query('SELECT state_json FROM live_watches WHERE run_id=$1',[run.id])).rows[0].state_json).not.toEqual(ctx.evaluator.snapshot());
 });
 it('does not restore a paused task even if its HTTP request succeeded',async()=>{
  const {run,service,add}=await fixture();const ctx=await add('paused-history');await pool.query("UPDATE live_runs SET status='paused' WHERE id=$1",[run.id]);
  await service.applyHistory(ctx,[{type:'price',result:{endpoint:'history',rows:[{time:210000,open:'1',high:'1',low:'1',close:'1',volume:'1'}]}}],()=>true);
  expect((await pool.query("SELECT count(*) n FROM meme_kline WHERE ca='paused-history'")).rows[0].n).toBe('0');
 });
 it('fills on closed-bar thresholds and atomically saves state/cash/equity; duplicate and restart are inert',async()=>{
  const {run,service,add}=await fixture();const ctx=await add('a');
  await service.executeBars([bar()]);
  const fills=(await pool.query('SELECT f.*,o.reason,o.raw_result AS evidence FROM live_fills f JOIN live_orders o ON o.id=f.order_id WHERE o.run_id=$1',[run.id])).rows;
  expect(fills).toHaveLength(1);expect(Number(fills[0].fill_price)).toBe(90);expect(fills[0].reason).toBe('stop_loss');expect(Number(fills[0].fill_time)).toBe(210000);
  expect(fills[0].evidence.executionVersion).toBe(LIVE_EXECUTION_VERSION);expect(fills[0].evidence.candle.close).toBe(95);
  expect(ctx.evaluator.state.position).toBeUndefined();expect(Number(run.cash)).toBeCloseTo(87.3);expect(Number(run.realized_pnl)).toBeCloseTo(-12.7);
  const saved=(await pool.query('SELECT * FROM live_watches WHERE run_id=$1',[run.id])).rows[0];expect(Number(saved.last_candle_time)).toBe(180000);
  ctx.evaluator=new LiveEvaluator(strategy,0,saved.state_json);
  await service.executeBars([bar()]);
  expect((await pool.query('SELECT COUNT(*) n FROM live_orders WHERE run_id=$1',[run.id])).rows[0].n).toBe('1');
 });
 it('rolls back the entire bar on a state-save fault, then retries exactly once',async()=>{
  const {run,service,add}=await fixture();const ctx=await add('a'),before=ctx.evaluator.snapshot();
  const connect=pool.connect.bind(pool);let fail=true;
  service.pool={query:pool.query.bind(pool),connect:async()=>{const c=await connect();return new Proxy(c,{get(target,key){if(key==='query')return async(sql:string,args:any[])=>{if(fail&&sql.startsWith('UPDATE live_watches')){fail=false;throw new Error('injected write fault');}return target.query(sql,args);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}};
  await expect(service.executeBars([bar()])).rejects.toThrow('injected write fault');expect(ctx.evaluator.snapshot()).toEqual(before);
  expect((await pool.query('SELECT COUNT(*) n FROM live_orders WHERE run_id=$1',[run.id])).rows[0].n).toBe('0');expect(Number(run.cash)).toBe(0);
  await service.executeBars([bar()]);expect((await pool.query('SELECT COUNT(*) n FROM live_orders WHERE run_id=$1',[run.id])).rows[0].n).toBe('1');
 });
 it('processes exits before entries with shared cash regardless of input ordering',async()=>{
  const {run,service,add}=await fixture();await add('z');const buyer=await add('a',false);
  const entry={...bar('a'),candle:{...bar('a').candle,open:14,high:14,low:14,close:14}};
  await service.executeBars([entry,bar('z')]);expect(buyer.evaluator.state.position).toBeDefined();
  const orders=(await pool.query('SELECT side,ca FROM live_orders WHERE run_id=$1 ORDER BY created_at,id',[run.id])).rows;
  expect(orders).toHaveLength(2);expect(Number(run.cash)).toBeCloseTo(77);expect(Number(run.cash)).toBeGreaterThanOrEqual(0);
 });
 it('fails closed when a market-cap bar has no matching price close',async()=>{
  const {run,service,add}=await fixture('paper','mcap');const ctx=await add('a');const before=ctx.evaluator.snapshot();
  await service.executeBars([bar('a','mcap')]);expect(ctx.ready).toBe(false);expect(ctx.evaluator.snapshot()).toEqual(before);
  expect((await pool.query('SELECT COUNT(*) n FROM live_orders WHERE run_id=$1',[run.id])).rows[0].n).toBe('0');
 });
 it('keeps market-cap decision values distinct from token prices in fills',async()=>{
  const {run,service,add}=await fixture('paper','mcap');await add('a');
  const supply={original:'100',unit:'tokens' as const,decimals:null,tokens:'100',fetchedAt:1000};
  const mc={...bar('a','mcap'),candle:{...bar().candle,open:10000,high:10100,low:8500,close:9500},marketCapBasis:{source:'price_supply' as const,value:'9500',supply},derivedSupply:supply,hasDerivedMarketCap:true};
  await service.executeBars([mc,bar()]);
  const f=(await pool.query('SELECT f.* FROM live_fills f JOIN live_orders o ON o.id=f.order_id WHERE o.run_id=$1',[run.id])).rows[0];
  expect(Number(f.fill_price)).toBe(90);expect(Number(f.fill_value)).toBe(9000);expect(Number(f.quantity)).toBe(1);expect(Number(run.realized_pnl)).toBeCloseTo(-12.7);
  const evidence=(await pool.query('SELECT raw_result FROM live_orders WHERE run_id=$1',[run.id])).rows[0].raw_result;expect(evidence.marketCapBasis).toEqual(mc.marketCapBasis);expect(evidence.derivedSupply).toEqual(supply);
 });
 it('switches existing runs once, cancels old paper intents and preserves positions',async()=>{
  const {run,service,add}=await fixture();const ctx=await add('a'),before=ctx.evaluator.snapshot();
  await pool.query('UPDATE live_watches SET state_json=$2 WHERE run_id=$1',[run.id,JSON.stringify(before)]);
  await pool.query("INSERT INTO live_orders(run_id,chain,ca,pair_id,intent_key,side,reason,status,decision_time,decision_value,requested_amount) VALUES($1,'sol','a','a',$2,'buy','entry','pending',0,100,10)",[run.id,randomUUID()]);
  await service.switchExecution();await service.switchExecution();
  const saved=(await pool.query('SELECT * FROM live_runs WHERE id=$1',[run.id])).rows[0];expect(saved.execution_version).toBe(LIVE_EXECUTION_VERSION);expect(saved.execution_switched_at).toBeTruthy();
  expect(saved.strategy_json.impulseCondition.selectionVersion).toBe('pullback-v2');
  const event=(await pool.query("SELECT payload FROM live_events WHERE run_id=$1 AND kind='execution_switched'",[run.id])).rows[0].payload;
  expect(event.impulseSelectionVersion).toBe('pullback-v2');
  const original=(await pool.query('SELECT state_json FROM live_watches WHERE run_id=$1',[run.id])).rows[0].state_json;
  expect(event.preservedPositions[0].position).toEqual(original.position);
  expect(new LiveEvaluator(saved.strategy_json,0,original).state.position).toEqual(original.position);
  expect((await pool.query('SELECT status FROM live_orders WHERE run_id=$1',[run.id])).rows[0].status).toBe('cancelled');expect(ctx.evaluator.snapshot()).toEqual(before);
  expect((await pool.query("SELECT COUNT(*) n FROM live_events WHERE run_id=$1 AND kind='execution_switched'",[run.id])).rows[0].n).toBe('1');
 });
 it('switches the market source atomically and keeps prior positions and cash intact',async()=>{
  const {run,service,add}=await fixture();const ctx=await add('a'),before=ctx.evaluator.snapshot();
  await pool.query("INSERT INTO live_orders(run_id,chain,ca,pair_id,intent_key,side,reason,status,decision_time,decision_value,requested_amount) VALUES($1,'sol','a','a',$2,'buy','entry','pending',0,100,10)",[run.id,randomUUID()]);
  await service.switchMarket();await service.switchMarket();
  const saved=(await pool.query('SELECT * FROM live_runs WHERE id=$1',[run.id])).rows[0];expect(saved.market_source).toBe('meme_market_v2');expect(saved.market_switched_at).toBeTruthy();expect(Number(saved.cash)).toBe(Number(run.cash));expect(ctx.evaluator.snapshot()).toEqual(before);
  expect((await pool.query('SELECT status FROM live_orders WHERE run_id=$1',[run.id])).rows[0].status).toBe('cancelled');expect((await pool.query("SELECT COUNT(*) n FROM live_events WHERE run_id=$1 AND kind='market_switched'",[run.id])).rows[0].n).toBe('1');
 });
 it('holds an uncertain real intent on restart instead of resending it',async()=>{
  const {run,service,add}=await fixture('live');await add('a');
  await pool.query("INSERT INTO live_orders(run_id,chain,ca,pair_id,intent_key,side,reason,status,decision_time,decision_value,requested_amount) VALUES($1,'sol','a','a',$2,'sell','stop_loss','pending',0,90,100)",[run.id,randomUUID()]);
  await service.switchExecution();await service.executeBars([bar()]);
  const orders=(await pool.query('SELECT status FROM live_orders WHERE run_id=$1',[run.id])).rows;expect(orders).toEqual([{status:'unknown'}]);
  expect((await pool.query('SELECT execution_hold_reason FROM live_runs WHERE id=$1',[run.id])).rows[0].execution_hold_reason).toBeTruthy();
 });
 it('does not create decisions or fills from an intra-bar tick',async()=>{
  const {run,service,add}=await fixture();await add('a');
  await service.onTrade({id:'tick1',chain:'sol',ca:'a',pairId:'a',time:180_001,price:100,mcap:100000,volumeUsd:1});
  await service.onTrade({id:'tick2',chain:'sol',ca:'a',pairId:'a',time:185_000,price:80,mcap:80000,volumeUsd:1});
  expect((await pool.query('SELECT COUNT(*) n FROM live_orders WHERE run_id=$1',[run.id])).rows[0].n).toBe('0');
 });
 it('submits real-mode orders only after bar state commits; never invents a real fill',async()=>{
  vi.stubEnv('LIVE_TRADING_ENABLED','true');const {run,service,add}=await fixture('live');await add('a');
  const swap=vi.fn(async()=>{expect((await pool.query('SELECT last_candle_time FROM live_watches WHERE run_id=$1',[run.id])).rows[0].last_candle_time).toBe('180000');return 'mock-tx-'+run.id;});
  service.xxyy={walletInfo:async()=>({address:run.wallet_address,tokenBalance:{uiAmount:1}}),swap};
  await service.executeBars([bar()]);expect(swap).toHaveBeenCalledOnce();await service.executeBars([bar()]);expect(swap).toHaveBeenCalledOnce();
  expect((await pool.query('SELECT COUNT(*) n FROM live_fills f JOIN live_orders o ON o.id=f.order_id WHERE o.run_id=$1',[run.id])).rows[0].n).toBe('0');
  expect((await pool.query('SELECT status FROM live_orders WHERE run_id=$1',[run.id])).rows[0].status).toBe('submitted');
 });
 it('does not submit a real order if the market interrupts during wallet preflight',async()=>{
  vi.stubEnv('LIVE_TRADING_ENABLED','true');const {run,service,add}=await fixture('live');const ctx=await add('a'),swap=vi.fn();
  service.xxyy={walletInfo:async()=>{ctx.ready=false;return {address:run.wallet_address,tokenBalance:{uiAmount:1}};},swap};
  await service.executeBars([bar()]);expect(swap).not.toHaveBeenCalled();expect((await pool.query('SELECT status FROM live_orders WHERE run_id=$1',[run.id])).rows[0].status).toBe('cancelled');
 });
});
