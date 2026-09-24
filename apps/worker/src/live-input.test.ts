import {describe,it,expect} from 'vitest';
import {parseMarketTrade,parseProjectSignal} from './live-input.js';
describe('external realtime data validation',()=>{
 it('accepts only allowed chain and source with millisecond times',()=>{
  const data={data:{chain:'BSC',token_address:'0x'+'A'.repeat(40),signal_source:'fomo_new_project_expanded',signal_time:1_780_000_000_123,id:'abc'}};
  expect(parseProjectSignal(data)).toMatchObject({chain:'bsc',ca:'0x'+'a'.repeat(40),time:1_780_000_000_123});
  expect(parseProjectSignal({...data,data:{...data.data,signal_source:'other'}})).toBeUndefined();
  expect(parseProjectSignal({...data,data:{...data.data,signal_time:1_780_000_000}})).toBeUndefined();
 });
 it('rejects unrelated pairs and missing transaction volume',()=>{
  const pair={chain:'sol',ca:'CA',pairId:'PAIR'};
  const input={data:{pairId:'PAIR',tokenAddress:'CA',timestamp:1_780_000_000_123,priceUsd:.01,marketCapUsd:10_000,amountUsd:40,signature:'sig'}};
  expect(parseMarketTrade(input,pair)).toMatchObject({id:'sig',price:.01,mcap:10_000,volumeUsd:40});
  expect(parseMarketTrade({...input,data:{...input.data,pairId:'wrong'}},pair)).toBeUndefined();
  expect(parseMarketTrade({...input,data:{...input.data,amountUsd:undefined}},pair)).toBeUndefined();
 });
});
