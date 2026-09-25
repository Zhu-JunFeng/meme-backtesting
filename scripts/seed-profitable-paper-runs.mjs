#!/usr/bin/env node
// Explicit, repeatable creation of source-isolated paper experiments. Never starts tasks.
const apiArg=process.argv.find(x=>x.startsWith('--api='));
const execute=process.argv.includes('--execute');
if(!apiArg){console.error('Usage: node scripts/seed-profitable-paper-runs.mjs --api=https://HOST/api [--execute]');process.exit(2);}
const base=apiArg.slice(6).replace(/\/$/,'');
if(!/^https?:\/\//.test(base)){console.error('API URL must be absolute');process.exit(2);}
const sources=[['fomo_new_project_expanded','扩大信号'],['top_cluster_first_buy','Top Cluster 首买']];
const strategies=[
 {chain:'robin',interval:'1m',code:'E0345',strategyVersionId:'86aaab8b-8740-4e76-8a04-9ebd860506a6'},
 {chain:'bsc',interval:'30s',code:'E0119',strategyVersionId:'66144120-f537-46c2-9de1-dfcf6a1f9ffb'},
];
const requests=strategies.flatMap(strategy=>sources.map(([signalSource,label])=>({
 name:`模拟盘实验 · ${strategy.chain.toUpperCase()} · ${strategy.code} · ${label}`,
 mode:'paper',chain:strategy.chain,interval:strategy.interval,valueType:'mcap',
 strategyVersionId:strategy.strategyVersionId,initialCapital:10000,signalSource,
 clientKey:`paper-v1:${strategy.chain}:${strategy.code.toLowerCase()}:${signalSource}`,
})));
async function call(path,init){
 const response=await fetch(`${base}${path}`,{...init,signal:AbortSignal.timeout(15000)});
 const data=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(data)}`);
 return data;
}
if(execute){
 for(const strategy of strategies){
  const version=await call(`/strategy-versions/${strategy.strategyVersionId}`);
  const config=version.strategyJson;
  const cost=config?.executionConfig;
  if(version.id!==strategy.strategyVersionId||config?.entryAfterSignal!==true||cost?.initialCapital!==10000||cost?.feePercent!==1||cost?.slippagePercent!==1||cost?.buyTaxPercent!==1||cost?.sellTaxPercent!==1)
   throw new Error(`Strategy preflight failed for ${strategy.chain} ${strategy.code}; no tasks created`);
 }
}
for(const body of requests){
 if(!execute){console.log(`DRY RUN ${body.clientKey} ${body.strategyVersionId} ${body.chain} ${body.interval} ${body.signalSource}`);continue;}
 const run=await call('/live-runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 if(run.status!=='paused'||run.mode!=='paper'||run.signal_source!==body.signalSource||run.strategy_version_id!==body.strategyVersionId||Number(run.initial_capital)!==10000)throw new Error(`Unexpected task state for ${body.clientKey}: ${run.id}`);
 console.log(`PAUSED ${body.clientKey} ${run.id}`);
}
