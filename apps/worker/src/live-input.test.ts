import {describe,it,expect} from 'vitest';
import {parseMarketTrade,parseMarketTrades,parseProjectSignal,resolveLivePool} from './live-input.js';
describe('external realtime data validation',()=>{
 it('maps trending triggers on three supported chains, retaining evidence and skipping multiples',()=>{
  const input={type:'signal_triggered',signal_code:'fomo_trending_new_project',trigger_time_ms:1791369003000,detail_id:'80',reached_multiple:null,trending:{rank:8,finished_at_ms:1791369000000,received_at_ms:1791369001000,fetched_at_ms:1791369002000},reason:{description:'首次上榜第8'}};
  for(const chain of ['bsc','robin','sol']){
   const message={...input,chain,ca:chain==='sol'?'UpBBfyC75u3kxDGWmmmW2yauk9YY3CqZhdt1KUDkids':'0x'+'A'.repeat(40)};
   expect(parseProjectSignal(message)).toMatchObject({key:'80',chain,source:'fomo_trending_new_project',time:input.trigger_time_ms,identity:{trending:input.trending,description:'首次上榜第8'}});
   expect(parseProjectSignal({...message,reached_multiple:150})).toBeUndefined();
  }
  expect(parseProjectSignal({...input,chain:'eth',ca:'0x'+'a'.repeat(40)})).toBeUndefined();
 });
 it('accepts only allowed chain and source with millisecond times',()=>{
  const data={data:{chain:'BSC',token_address:'0x'+'A'.repeat(40),signal_source:'fomo_new_project_expanded',signal_time:1_780_000_000_123,id:'abc'}};
  expect(parseProjectSignal(data)).toMatchObject({chain:'bsc',ca:'0x'+'a'.repeat(40),time:1_780_000_000_123});
  expect(parseProjectSignal({...data,data:{...data.data,signal_source:'other'}})).toBeUndefined();
  expect(parseProjectSignal({...data,data:{...data.data,signal_time:1_780_000_000}})).toBeUndefined();
  const observed={type:'signal_triggered',chain:'ROBIN',ca:'0x'+'B'.repeat(40),signal_code:'top_cluster_first_buy',trigger_time_ms:1_790_334_422_905,detail_id:'594333',signal_name:'Top Cluster'};
  expect(parseProjectSignal(observed)).toMatchObject({chain:'robin',source:'top_cluster_first_buy',time:observed.trigger_time_ms,key:'594333'});
  expect(parseProjectSignal({...observed,signal_code:'twitter_behavior_call'})).toBeUndefined();
 });
 it('rejects unrelated pairs and missing transaction volume',()=>{
  const pair={chain:'sol',ca:'CA',pairId:'PAIR'};
  const input={data:{pairId:'PAIR',tokenAddress:'CA',timestamp:1_780_000_000_123,priceUsd:.01,marketCapUsd:10_000,amountUsd:40,signature:'sig'}};
  expect(parseMarketTrade(input,pair)).toMatchObject({id:'sig',price:.01,mcap:10_000,volumeUsd:40});
  expect(parseMarketTrade({...input,data:{...input.data,pairId:'wrong'}},pair)).toBeUndefined();
  expect(parseMarketTrade({...input,data:{...input.data,amountUsd:undefined}},pair)).toBeUndefined();
  const observed={timestamp:1_790_334_387_207,priceUsd:'0.0001493274434902554959455',marketCapUSD:'144392.4276237604492612084346958866460',usdAmount:'5.0368144234320007802616796655980',txHash:'sample-tx',type:'sell'};
  const parsed=parseMarketTrades(JSON.stringify([observed]),'D_TOKEN_DETAIL_pfamm_PAIR','D_TOKEN_DETAIL_pfamm_PAIR',pair);
  expect(parsed).toHaveLength(1);
  expect(parsed[0].id).toBe('sample-tx');
  expect(parsed[0].mcap).toBeCloseTo(144392.4276,3);
  expect(parsed[0].volumeUsd).toBeCloseTo(5.03681442,6);
  expect(parseMarketTrades(JSON.stringify([observed]),'another-channel','D_TOKEN_DETAIL_pfamm_PAIR',pair)).toEqual([]);
 });
 it('derives Socket.IO dexId from the main pair rather than display name',()=>{
  expect(resolveLivePool({main_pair_id:'0xPAIR',dex_name:'Flap.sh',project_meta:{outer_pair_address:'0xpair',outer_dex:'pan2'}})).toEqual({pairId:'0xPAIR',dexId:'pan2'});
  expect(resolveLivePool({main_pair_id:'0xPAIR',current_market_cap:'50000',project_meta:{outer_pair_address:'0xpair',outer_dex:'pan2'}})).toEqual({pairId:'0xPAIR',dexId:'pan2',marketCap:50_000});
  expect(resolveLivePool({main_pair_id:'0xPAIR',dex_name:'Pons',project_meta:{outer_pair_address:'0xpair',outer_dex:'uni4'}})).toEqual({pairId:'0xPAIR',dexId:'uni4'});
  expect(resolveLivePool({main_pair_id:'0xPAIR',project_meta:{outer_pair_address:'0xother',outer_dex:'pan2'}})).toBeUndefined();
 });
});
