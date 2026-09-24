import {createHash} from 'node:crypto';
import type {MarketTrade} from '@meme/engine';
export interface ProjectSignal {key:string;chain:'sol'|'bsc'|'robin';ca:string;source:'top_cluster_first_buy'|'fomo_new_project_expanded';time:number;identity:Record<string,unknown>}
const object=(v:unknown):Record<string,unknown>|undefined=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
const str=(...values:unknown[])=>values.find(v=>typeof v==='string'&&v.trim()) as string|undefined;
const numeric=(...values:unknown[])=>{for(const v of values){const n=typeof v==='number'?v:typeof v==='string'&&v.trim()?Number(v):NaN;if(Number.isFinite(n))return n;}return undefined;};
const milliseconds=(value:unknown)=>{const n=numeric(value);return n!==undefined&&Number.isSafeInteger(n)&&n>1_000_000_000_000&&n<8_640_000_000_000_000?n:undefined;};
const decode=(input:unknown)=>{if(typeof input!=='string')return object(input);try{return object(JSON.parse(input));}catch{return undefined;}};
export function parseProjectSignal(input:unknown):ProjectSignal|undefined{
 const root=decode(input);if(!root)return;
 const data=object(root.data)??object(root.payload)??root;
 const chain=str(data.chain,data.chainId)?.toLowerCase();
 const source=str(data.signal_source,data.signalSource,data.type,root.signal_source,root.signalSource);
 const ca=str(data.ca,data.token_address,data.tokenAddress,data.contract_address,data.contractAddress);
 const time=milliseconds(data.signal_time??data.signalTime??data.trigger_time??data.triggerTime??data.timestamp);
 if(!['sol','bsc','robin'].includes(chain??'')||!['top_cluster_first_buy','fomo_new_project_expanded'].includes(source??'')||!ca||!time)return;
 if(chain!=='sol'&&!/^0x[0-9a-fA-F]{40}$/.test(ca))return;
 const normalized=chain==='sol'?ca:ca.toLowerCase(),detail=str(data.detail_id,data.detailId,data.id,root.id);
 const key=detail??createHash('sha256').update(`${chain}:${normalized}:${source}:${time}`).digest('hex');
 return {key,chain:chain as ProjectSignal['chain'],ca:normalized,source:source as ProjectSignal['source'],time,identity:{id:detail??null,source,chain,ca:normalized}};
}
export function parseMarketTrade(input:unknown,expected:{chain:string;ca:string;pairId:string}):MarketTrade|undefined{
 const root=decode(input);if(!root)return;
 const data=object(root.data)??root;
 const chain=str(data.chain,data.chainId);
 if(chain&&chain.toLowerCase()!==expected.chain)return;
 const pair=str(data.pair_id,data.pairId,data.pair_address,data.pairAddress);
 const ca=str(data.token_address,data.tokenAddress,data.ca);
 if(pair && pair.toLowerCase()!==expected.pairId.toLowerCase())return;
 if(ca && ca.toLowerCase()!==expected.ca.toLowerCase())return;
 const time=milliseconds(data.timestamp??data.trade_time??data.tradeTime??data.time);
 const price=numeric(data.price_usd,data.priceUsd,data.priceUSD,data.price);
 const mcap=numeric(data.market_cap_usd,data.marketCapUsd,data.marketCapUSD,data.mc);
 const volumeUsd=numeric(data.volume_usd,data.volumeUsd,data.amount_usd,data.amountUsd,data.total_usd,data.totalUsd);
 const id=str(data.tx_hash,data.txHash,data.signature,data.id,root.id);
 if(!time||!price||price<=0||volumeUsd===undefined||volumeUsd<0||!id)return;
 return {id,chain:expected.chain,ca:expected.ca,pairId:expected.pairId,time,price,mcap:mcap&&mcap>0?mcap:undefined,volumeUsd};
}
