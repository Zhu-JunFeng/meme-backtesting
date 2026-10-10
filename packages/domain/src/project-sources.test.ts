import {describe,it,expect} from 'vitest';
import {defaultProjectSources,normalizeProjectSources,qualifiesSource,effectiveExitCap,feedQuery,selectedProjectSources} from './project-sources.js';
describe('project source rules',()=>{
 const now=1800000000000;
 it('keeps legacy all as the original MemeInfo subset only',()=>{const c=selectedProjectSources({signal_source:'all'});expect(c.memeinfo.signalSources).toEqual(['fomo_new_project_expanded','top_cluster_first_buy']);expect(c.wallet.enabled).toBe(false);expect(c.xxyy.enabled).toBe(false);});
 it('validates enabled chains, versions, empty sets and exit caps',()=>{const c=defaultProjectSources();c.wallet.enabled=true;expect(()=>normalizeProjectSources(c,'bsc')).toThrow('仅支持 SOL');c.wallet.exitMarketCap=30000;expect(()=>normalizeProjectSources(c,'sol')).toThrow('剔除市值');c.wallet.exitMarketCap=20000;c.wallet.enabled=false;c.memeinfo.enabled=false;expect(()=>normalizeProjectSources(c,'sol')).toThrow('至少');expect(()=>normalizeProjectSources({...c,version:2},'sol')).toThrow('版本');});
 it('uses strict age and entry cap, inclusive KOL and exclusive eviction',()=>{const c=defaultProjectSources();c.wallet.enabled=true;c.xxyy.enabled=true;
  expect(qualifiesSource('memeinfo',c.memeinfo,{marketCap:50000},now)).toBe(true);
  expect(qualifiesSource('wallet',c.wallet,{marketCap:20000,createdAt:now-1},now)).toBe(false);
  expect(qualifiesSource('wallet',c.wallet,{marketCap:20001,createdAt:now-1800000},now)).toBe(false);
  expect(qualifiesSource('wallet',c.wallet,{marketCap:20001,createdAt:now-1799999},now)).toBe(true);
  const facts={marketCap:30001,createdAt:now-7199999,kol:2,dexId:'pfamm'};
  expect(qualifiesSource('xxyy',c.xxyy,facts,now)).toBe(true);
  for(const wrong of [{createdAt:now-7200000},{createdAt:now+1},{marketCap:30000},{kol:1},{kol:undefined},{dexId:'pump'},{createdAt:undefined},{marketCap:NaN}])expect(qualifiesSource('xxyy',c.xxyy,{...facts,...wrong},now)).toBe(false);
 });
 it('counts only actual matched sources even when disabled later',()=>{const c=defaultProjectSources();expect(effectiveExitCap(c,['memeinfo'])).toBe(50000);expect(effectiveExitCap(c,['memeinfo','wallet'])).toBe(20000);c.wallet.exitMarketCap=12000;expect(effectiveExitCap(c,['memeinfo','wallet'])).toBe(12000);});
 it('combines filters into one broad query without changing per-run rules',()=>{const a=defaultProjectSources(),b=defaultProjectSources();a.xxyy.enabled=b.xxyy.enabled=true;b.xxyy.maxAgeMinutes=30;b.xxyy.minMarketCap=20000;b.xxyy.minKol=5;expect(feedQuery([a,b])).toEqual({createTime:'0,120',mc:'20000,',kol:'2,',dex:['pump']});expect(feedQuery([defaultProjectSources()])).toBeNull();});
});
