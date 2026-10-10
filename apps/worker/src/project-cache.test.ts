import {describe,it,expect,vi} from 'vitest';
import {ProjectCache,cacheKey,normalizedSupply,projectInfo,resolveMarketCap,projectCreatedAt} from './project-cache.js';
import {LiveCandleAggregator} from '@meme/engine';
const project={chain:'robin',ca:'0xABC'},item={chain:'robin',token_address:'0xabc',main_pair_id:'p',current_market_cap:'150000',project_meta:{total_supply:'1000000000000000000',decimals:'9'}};
const response=(x:any=item)=>({ok:true,json:async()=>({data:{caListTokenList:[x]}})}) as Response;
function memory(){const map=new Map<string,string>();return {get:vi.fn(async(k:string)=>map.get(k)??null),set:vi.fn(async(k:string,v:string)=>{map.set(k,v);})};}
describe('exact supply and market cap',()=>{
 it('converts raw supply once and multiplies without display rounding',()=>{const info=projectInfo(item,project,1);expect(info.supply?.tokens).toBe('1000000000');expect(resolveMarketCap({price_usd:'0.000150446816343934',market_cap_usd:null},info)?.value).toBe('150446.816343934');});
 it('does not divide a declared token supply again; supports decimals zero',()=>{
  expect(normalizedSupply('1000000000','tokens',9,1).tokens).toBe('1000000000');expect(normalizedSupply('7','raw',0,1).tokens).toBe('7');
 });
 it('handles large integers and very small prices exactly',()=>{
  const supply=normalizedSupply('10000000000000000000000000000000000000001','raw',18,1);
  const info={...projectInfo(item,project,1),supply};expect(resolveMarketCap({price_usd:'0.00000000000000000001'},info)?.value).toBe('100.00000000000000000000000000000000000001');
 });
 it.each([['0','raw',9],['1.1','raw',9],['1','raw',null],['1','unknown',9],['1','raw',-1]])('rejects invalid supply %s %s %s',(v,u,d)=>{expect(()=>normalizedSupply(v,u,d,0)).toThrow();});
 it('prefers valid WS cap and rejects wrong-chain or wrong-case SOL metadata',()=>{
  expect(resolveMarketCap({price_usd:'1',market_cap_usd:'42'},projectInfo(item,project,1))).toEqual({source:'ws',value:'42'});
  expect(()=>projectInfo({...item,chain:'sol'},project,1)).toThrow();expect(()=>projectInfo({...item,chain:'sol',token_address:'abc'},{chain:'sol',ca:'ABC'},1)).toThrow();
  expect(cacheKey({chain:'SOL',ca:' AbC '})).toBe('meme:project-info:v1:sol:AbC');
 });
 it('falls back from invalid cap but never invents supply',()=>{const info=projectInfo(item,project,1);expect(resolveMarketCap({price_usd:'0.001',market_cap_usd:'NaN'},info)?.value).toBe('1000000');expect(resolveMarketCap({price_usd:'1',market_cap_usd:null})).toBeUndefined();});
 it('aggregates derived market-cap OHLCV with the matching price and retains provenance',()=>{
  const info=projectInfo(item,project,1),bars:any[]=[];const agg=new LiveCandleAggregator(b=>bars.push(b));
  for(const [id,time,price] of [['a',60000,'0.001'],['b',65000,'0.002']] as const){const basis=resolveMarketCap({price_usd:price},info)!;agg.accept({id,chain:'robin',ca:'0xabc',pairId:'p',time,price:Number(price),volumeUsd:10,mcap:Number(basis.value),marketCapBasis:basis});}
  agg.flush(120000);const mc=bars.find(b=>b.type==='mcap'&&b.interval==='1m');expect(mc.candle).toMatchObject({open:1000000,high:2000000,low:1000000,close:2000000,volume:20});expect(mc.marketCapBasis.supply.tokens).toBe('1000000000');expect(mc.hasDerivedMarketCap).toBe(true);
 });
 it('retains derived supply when a mixed-source candle closes on a WS market cap',()=>{
  const info=projectInfo(item,project,1),bars:any[]=[];const agg=new LiveCandleAggregator(b=>bars.push(b));
  for(const [id,time,cap] of [['a',60000,null],['b',65000,'1200000']] as const){const basis=resolveMarketCap({price_usd:'0.001',market_cap_usd:cap},info)!;agg.accept({id,chain:'robin',ca:'0xabc',pairId:'p',time,price:0.001,volumeUsd:10,mcap:Number(basis.value),marketCapBasis:basis});}
  agg.flush(120000);const mc=bars.find(b=>b.type==='mcap'&&b.interval==='1m');expect(mc.marketCapBasis.source).toBe('ws');expect(mc.derivedSupply).toEqual(info.supply);expect(mc.hasDerivedMarketCap).toBe(true);
 });
});
describe('single query and persistent retry ledger',()=>{
 it('refreshes dynamic cap with single-flight and never returns expired cap after failure',async()=>{
  let now=Date.now();const request=vi.fn(async()=>response({...item,token_create_time:now-100000})) as any;
  const cache=new ProjectCache(memory(),request,()=>now);
  await Promise.all([cache.fresh(project),cache.fresh(project)]);expect(request).toHaveBeenCalledTimes(1);
  now+=61000;request.mockResolvedValueOnce(response({...item,current_market_cap:'23000'}));
  expect((await cache.fresh(project)).marketCap).toBe(23000);expect(request).toHaveBeenCalledTimes(2);
  now+=61000;request.mockRejectedValueOnce(new Error('offline'));await expect(cache.fresh(project)).rejects.toThrow('offline');
 });
 it('uses token creation time and validates seconds, milliseconds, fallback and future values',()=>{
  const t=1700000000000;
  expect(projectCreatedAt({token_create_time:t/1000})).toBe(t);
  expect(projectCreatedAt({token_create_time:t})).toBe(t);
  expect(projectCreatedAt({token_create_time:'bad',project_meta:{create_time:new Date(t).toISOString()}})).toBe(t);
  expect(projectCreatedAt({token_create_time:Date.now()+100000})).toBeUndefined();
 });
 it('shares concurrent lookups and reuses Redis after process restart',async()=>{
  const store=memory(),request=vi.fn(async()=>response()) as any;const cache=new ProjectCache(store,request);
  await Promise.all([cache.get(project),cache.get({chain:'robin',ca:'0xabc'}),cache.get(project)]);await cache.get(project);expect(request).toHaveBeenCalledTimes(1);
  const restarted=new ProjectCache(store,request);expect((await restarted.get(project)).supply?.tokens).toBe('1000000000');expect(request).toHaveBeenCalledTimes(1);
 });
 it('persists failures, respects backoff, and stops after three attempts even after restart',async()=>{
  const store=memory(),request=vi.fn(async()=>{throw new Error('offline');}) as any;let now=1000;let cache=new ProjectCache(store,request,()=>now);
  await expect(cache.get(project)).rejects.toThrow('offline');await expect(cache.get(project)).rejects.toThrow();expect(request).toHaveBeenCalledTimes(1);
  now+=5000;cache=new ProjectCache(store,request,()=>now);await expect(cache.get(project)).rejects.toThrow();now+=10000;await expect(cache.get(project)).rejects.toThrow();now+=100000;cache=new ProjectCache(store,request,()=>now);await expect(cache.get(project)).rejects.toThrow();expect(request).toHaveBeenCalledTimes(3);
 });
 it('falls back to memory when Redis is unavailable, without repeating successful HTTP calls',async()=>{
  const store={get:async()=>{throw new Error('redis');},set:async()=>{throw new Error('redis');}},request=vi.fn(async()=>response()) as any;const cache=new ProjectCache(store,request);await cache.get(project);await cache.get(project);expect(cache.storageStatus).toBe('memory');expect(request).toHaveBeenCalledTimes(1);
 });
 it('missing supply is a retryable lookup failure, not a zero market cap',async()=>{const cache=new ProjectCache(undefined,vi.fn(async()=>response({...item,project_meta:{}})) as any);await expect(cache.get(project)).rejects.toThrow();expect(cache.peek(project)).toBeUndefined();});
});
