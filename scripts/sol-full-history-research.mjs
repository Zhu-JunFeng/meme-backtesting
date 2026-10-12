/** Local files only. Exploratory full-history fitting, never a production task submitter. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename,unlink,readdir} from 'node:fs/promises';
import {openSync,writeSync,closeSync,createReadStream,createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {ENGINE_VERSION,poolKey} from '../packages/engine/dist/index.js';
import {generateStrategyDescription,withCurrentImpulseSelection} from '../packages/domain/dist/index.js';
import {canonical,evaluateWindow,realCandleAt} from './offline-strategy-research.mjs';
import {candidatesAround} from './explore-strategy-neighborhood.mjs';
import {loadInputs,earliestSignals} from './cohort-research.mjs';
import {hash,fileHash,saveJson} from './cohort-snapshot.mjs';
import {COSTS} from './temporal-holdout-research.mjs';

export const STUDY_VERSION=1,SEED=20261012,SIZES=[1,2,3,5,7.5,10];
const intervals=['30s','1m'],caKey=s=>JSON.stringify([s.chain,s.ca]);
const read=async p=>JSON.parse(await readFile(p,'utf8'));
const signature=c=>hash(canonical({interval:c.interval,config:c.config}));
async function codeFingerprint(){
 const root=new URL('../',import.meta.url),files=['scripts/sol-full-history-research.mjs','scripts/offline-strategy-research.mjs','scripts/explore-strategy-neighborhood.mjs','scripts/cohort-research.mjs','scripts/cohort-snapshot.mjs','scripts/temporal-holdout-research.mjs'];
 for(const dir of ['packages/engine/dist/','packages/domain/dist/'])for(const f of (await readdir(new URL(dir,root))).sort())if(f.endsWith('.js'))files.push(dir+f);
 const entries=[];for(const f of files)entries.push([f,await fileHash(new URL(f,root))]);return hash(entries);
}
export function normalizeStrategy(input){
 const keys=['schemaVersion','impulseCondition','entryConditionGroup','invalidationConditionGroup','addConditionGroup','exitConfig','positionConfig'];
 const c=withCurrentImpulseSelection(Object.fromEntries(keys.filter(k=>input[k]!==undefined).map(k=>[k,structuredClone(input[k])])));
 c.entryAfterSignal=false;c.minimumSignalAgeMinutes=0;c.executionConfig=structuredClone(COSTS);c.exitConfig.closeAtEnd=true;
 c.positionConfig={...c.positionConfig,mode:'single_entry',maxEntries:1,sizing:{type:'fixed_percent',value:c.positionConfig.sizing.value}};
 assert(SIZES.includes(c.positionConfig.sizing.value));assert([1,2,3].includes(c.positionConfig.maxConcurrentPositions));
 c.addConditionGroup={mode:'all',enabled:false,conditions:[]};return c;
}
export function selectBases(metadata,prior){
 const versions=[...metadata.versions].reverse();
 const get=name=>{const v=versions.find(v=>v.name===name);assert(v,`Missing baseline ${name}`);return {config:v.strategy_json,sourceVersionId:v.id,sourceVersion:v.version};};
 assert.equal(prior.id,'30s-E0103','Prior file must be the SOL E0103 baseline');
 return [
  {name:'默认模板',...get('Meme Fib 黄金口袋回撤')},
  {name:'SOL E0056',...get('数据库信号后买入 · SOL · 探索 E0056 训练期亏损 · 20260922')},
  {name:'E0129',...get('三链测试集综合第一 · 30s-E0129 · Trending 模拟观察（验证亏损）')},
  {name:'SOL E0103',config:prior.config}
 ].map(x=>{const c=structuredClone(x.config),sourceConfigHash=hash(canonical(c));let sizingAdjustment;
  if(c.positionConfig.sizing.type==='fixed_amount'){
   const value=c.positionConfig.sizing.value/COSTS.initialCapital*100;
   assert(SIZES.includes(value),'Fixed-amount baseline has no exact allowed percentage equivalent');
   sizingAdjustment=`固定金额 ${c.positionConfig.sizing.value} USD 转为初始资金等值的可用现金 ${value}%，后续随现金变化`;
   c.positionConfig.sizing={type:'fixed_percent',value};
  }
  return {...x,sourceConfigHash,...(sizingAdjustment?{sizingAdjustment}:{}),config:normalizeStrategy(c)};
 });
}
export function firstRound(bases,count=512,seed=SEED){
 assert(Number.isInteger(count)&&count>=bases.length&&count<=2000);
 const out=[];
 for(const [j,interval] of intervals.entries()){
  const seen=new Set();
  const add=(config,label)=>{config=normalizeStrategy(config);const sig=signature({interval,config});if(seen.has(sig))return;seen.add(sig);out.push({id:`${interval}-R1-${String(seen.size).padStart(4,'0')}`,interval,config,...(label?{baseline:label}:{})});};
  bases.forEach(b=>add(b.config,b.name));
  const generated=candidatesAround(bases.map(b=>b.config),Math.min(5000,count*2),seed+j);
  for(const [i,row] of generated.entries()){
   if(seen.size>=count)break;const c=row.config;c.positionConfig.sizing.value=SIZES[i%SIZES.length];
   if(i%5===0)c.invalidationConditionGroup=[{mode:'any',enabled:false,conditions:[]},{mode:'any',conditions:[{type:'break_fib_invalidation',ratio:.886}]},{mode:'any',conditions:[{type:'break_swing_low_invalidation',bufferPercent:2}]},{mode:'any',conditions:[{type:'bearish_volume_invalidation',period:10,minRatio:2,minBodyPercent:20}]}][Math.floor(i/5)%4];
   add(c);
  }
  assert.equal(seen.size,count,'Candidate generation exhausted');
 }
 return out;
}
export const ranking=rows=>rows.filter(r=>r.totalTrades>0&&Number.isFinite(r.accountReturn)).sort((a,b)=>b.accountReturn-a.accountReturn||a.accountMaxDrawdown-b.accountMaxDrawdown||b.totalTrades-a.totalTrades||a.id.localeCompare(b.id));
export function secondRound(first,rows,count=200,seed=SEED){
 assert(Number.isInteger(count)&&count>=0&&count<=1000);const seen=new Set(first.map(signature)),out=[];
 for(const [j,leader] of ranking(rows).slice(0,5).entries()){
  const base=first.find(c=>c.id===leader.id);assert(base);let added=0;
  for(const [i,row] of candidatesAround([base.config],Math.min(5000,Math.max(1,count*3)),seed+100+j).entries()){
   if(added>=count)break;const c=normalizeStrategy(row.config);
   if(i%3===0)c.positionConfig.sizing.value=SIZES[Math.floor(i/3)%SIZES.length];
   const candidate={interval:base.interval,config:c},sig=signature(candidate);if(seen.has(sig))continue;
   seen.add(sig);out.push({...candidate,id:`${base.interval}-R2-${j+1}-${String(++added).padStart(4,'0')}`,parent:base.id});
  }
 }
 return out;
}
export function attribution(trades,signals){
 const times=new Map(signals.map(s=>[caKey(s),s.signalTime]));
 const out=Object.fromEntries(['beforeOrAtSignal','afterSignal','missingSignal'].map(k=>[k,{trades:0,netPnl:0}]));
 for(const t of trades){const time=times.get(caKey(t.symbol));const group=time===undefined?'missingSignal':t.entryTime>time?'afterSignal':'beforeOrAtSignal';out[group].trades++;out[group].netPnl+=t.netPnl;}
 return out;
}
export function evaluate(candidate,inputs,signals,asOf,onBatch){
 assert(inputs.length);const from=Math.min(...inputs.map(p=>p.candles[0].time));
 const byCa=Object.fromEntries(inputs.map(p=>[caKey(p.symbol),0])),exitReasons={},tradesForAttribution=[];let fees=0,slippage=0,tax=0,syntheticEntries=0,minCash=candidate.config.executionConfig.initialCapital;
 const real=new Map(inputs.map(p=>[poolKey(p.symbol),p.candles])),tradeHash=createHash('sha256'),signalHash=createHash('sha256');
 const result=evaluateWindow(candidate,inputs,from,asOf,{interval:candidate.interval,warmupBars:0,onBatch:batch=>{
  onBatch?.(batch);
  for(const point of batch.equity){assert(Number.isFinite(point.cash)&&point.cash>=-1e-7,'Shared cash overdraft');minCash=Math.min(minCash,point.cash);}
  for(const s of batch.signals){signalHash.update(JSON.stringify(canonical(s))+'\n');if(s.type==='entry'||s.type==='add')syntheticEntries+=Number(!realCandleAt(real.get(poolKey(s.symbol))??[],s.time));}
  for(const t of batch.trades){tradeHash.update(JSON.stringify(canonical(t))+'\n');fees+=t.fees;slippage+=t.slippageCost;tax+=t.taxCost;
   const k=caKey(t.symbol);byCa[k]=(byCa[k]??0)+t.netPnl;
   const reason=exitReasons[t.exitReason]??={count:0,netPnl:0};reason.count++;reason.netPnl+=t.netPnl;
   tradesForAttribution.push({symbol:t.symbol,entryTime:t.entryTime,netPnl:t.netPnl});
  }
 }});
 const total=Object.values(byCa).reduce((a,b)=>a+b,0);assert(Math.abs(total-result.netPnl)<=1e-7*Math.max(1,Math.abs(total)),'CA totals differ from account');
 const best=Object.entries(byCa).filter(([,pnl])=>pnl>0).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0];
 return {...result,interval:candidate.interval,lowSample:result.totalTrades<10,costs:{fees,slippage,tax,total:fees+slippage+tax},syntheticEntries,minCash,
  byCa,exitReasons,attribution:attribution(tradesForAttribution,signals),bestCa:best?{key:best[0],netPnl:best[1],shareOfNet:result.netPnl>0?best[1]/result.netPnl:null}:null,
  tradeHash:tradeHash.digest('hex'),signalHash:signalHash.digest('hex')};
}
function sameReplay(a,b){for(const k of ['accountReturn','netPnl','accountMaxDrawdown','totalTrades','tradeHash','signalHash'])assert.equal(a[k],b[k],`Replay differs: ${k}`);}
export function reportMarkdown(report){
 const f=v=>Number.isFinite(v)?v.toFixed(2):'—',b=report.leaders[0];
 const lines=['# SOL 全历史策略搜索（不限制信号后买入）','',report.scope,'',
  `冻结截止：${new Date(report.asOf).toISOString()}（UTC）；引擎 ${report.engineVersion}；快照 SHA-256：${report.snapshotHash}。`,
  `候选 ${report.candidates} 个，有成交且净盈利 ${report.profitable} 个。初始资金 10,000 USD；手续费、滑点、买税、卖税各 1%；末根平仓和全部成本纳入排名。`,'',
  '## 数据覆盖','', '| 周期 | CA | 池 | 有效已收盘 K 线 | 非法行 | 缺口桶 | 无信号 CA | 无对应周期数据池 |','|---|---:|---:|---:|---:|---:|---:|---:|'];
 for(const [interval,c] of Object.entries(report.coverage))lines.push(`| ${interval} | ${c.cas} | ${c.pools} | ${c.validClosedRows} | ${c.invalid} | ${c.gapBuckets} | ${c.missingSignalCas.length} | ${c.noDataPools.length} |`);
 lines.push('','## 前十名','', '| 候选 | 周期 | 净收益率 | 净利润 USD | 最大回撤 | 胜率 | 交易数 | 盈亏因子 | 成本 USD |','|---|---|---:|---:|---:|---:|---:|---:|---:|');
 for(const r of report.leaders)lines.push(`| ${r.id}${r.lowSample?'（样本不足）':''} | ${r.interval} | ${f(r.accountReturn)}% | ${f(r.netPnl)} | ${f(r.accountMaxDrawdown)}% | ${f(r.accountWinRate)}% | ${r.totalTrades} | ${f(r.profitFactor)} | ${f(r.costs.total)} |`);
 lines.push('','## 前三名压力测试','', '| 候选 | 原收益率 | 滑点 2% | 移除最大盈利 CA 重放 |','|---|---:|---:|---:|');
 for(const r of report.leaders.slice(0,3))lines.push(`| ${r.id} | ${f(r.accountReturn)}% | ${f(r.stress?.accountReturn)}% | ${f(r.withoutBestCa?.accountReturn)}% |`);
 if(b){lines.push('','## 最佳候选的完整规则','',b.description.generatedText,'','## 最佳候选归因','',
  `- 最大盈利 CA：${b.bestCa?.key??'—'}，净利润 ${f(b.bestCa?.netPnl)} USD，占总净利润 ${f(b.bestCa?.shareOfNet==null?null:b.bestCa.shareOfNet*100)}%。`,
  `- 结束平仓：${b.excludedCount} 笔，净利润 ${f(b.excludedNet)} USD（已包含在排名内）。`,
  `- 补齐 K 线入场：${b.syntheticEntries} 次。`);
  for(const [k,label] of [['beforeOrAtSignal','信号前或等时'],['afterSignal','信号后'],['missingSignal','无信号记录']])lines.push(`- ${label}：${b.attribution[k].trades} 笔，净利润 ${f(b.attribution[k].netPnl)} USD。`);
 }
 lines.push('','逐根回放只使用当时已确认的 Pivot，但研究事后已知的 CA 名单存在项目发现偏差。信号前收益不代表当前模拟盘能够捕获；本次没有独立验证集，也不构成未来盈利保证。未提交服务器回测、未替换模拟盘、未开启实盘。','',
  '完整配置、逐 CA 盈亏、信号归因及压力测试见 report.json；前十名原始交易、事件和权益见对应 details.jsonl.gz。盈亏因子为无穷大或无分母时显示“—”。','');
 return lines.join('\n');
}
export async function research({snapshot,output,priorPath='output/holdout-5050-20261007/sol/report.json',count=512,refine=200,seed=SEED,maxRuns=Infinity,workers=4}){
 assert(Number.isInteger(workers)&&workers>=1&&workers<=8,'workers must be 1–8');
 snapshot=resolve(snapshot);output=resolve(output);await mkdir(output,{recursive:true});
 const manifest=await read(resolve(snapshot,'manifest.json')),{checksum,...unsigned}=manifest;
 assert.equal(hash(unsigned),checksum,'Manifest changed');assert.equal(manifest.engineVersion,ENGINE_VERSION);assert(manifest.closedOnly);assert.deepEqual(manifest.selectedChains,['sol']);
 assert.equal(await fileHash(resolve(snapshot,'metadata.json')),manifest.metadataHash);
 const metadata=await read(resolve(snapshot,'metadata.json')),prior=await read(priorPath),bases=selectBases(metadata,prior),candidates=firstRound(bases,count,seed),asOf=Date.parse(manifest.startedAt);
 const signals=earliestSignals([...metadata.token_info,...metadata.token_signal_events,...(metadata.live_signals??[])].filter(s=>s.chain==='sol'));
 const protocol={version:STUDY_VERSION,engineVersion:ENGINE_VERSION,codeHash:await codeFingerprint(),snapshotHash:checksum,asOf,seed,countPerInterval:count,refinePerLeader:refine,bases,candidates,
  entryAfterSignal:false,selectionVersion:'pullback-v2',ranking:'full_history_net_return_desc_drawdown_asc_trades_desc_id_asc',costs:COSTS,
  warning:'全历史拟合，非独立验证；信号前可买入，事后已知 CA 名单不代表当时可以发现项目。'};
 const protocolHash=hash(protocol),pp=resolve(output,'protocol.json');
 try{assert.equal(hash(await read(pp)),protocolHash,'Resume protocol changed');}catch(e){if(e.code!=='ENOENT')throw e;await saveJson(pp,protocol);}
 let progress={protocolHash,rows:[]};const progressPath=resolve(output,'progress.json');
 try{progress=await read(progressPath);assert.equal(progress.protocolHash,protocolHash);}catch(e){if(e.code!=='ENOENT')throw e;}
 const cached=new Map(progress.rows.map(r=>[r.id,r]));assert.equal(cached.size,progress.rows.length);
 let loadedInterval,inputs,coverage={},runs=0;
 async function load(interval){
  if(loadedInterval===interval)return inputs;inputs=undefined;global.gc?.();const loaded=await loadInputs(snapshot,manifest,'sol',interval);let gaps=0;
  inputs=loaded.inputs.map(p=>({...p,candles:p.candles.filter(c=>c.time<asOf&&c.closeTime<=asOf)})).filter(p=>p.candles.length);
  const step=interval==='30s'?30000:60000;for(const p of inputs)for(let i=1;i<p.candles.length;i++)gaps+=Math.max(0,Math.ceil((p.candles[i].time-p.candles[i-1].time)/step)-1);
  const present=new Set(inputs.map(p=>poolKey(p.symbol))),known=new Set(signals.map(caKey));
  coverage[interval]={rows:loaded.rows,invalid:loaded.invalid,validClosedRows:inputs.reduce((n,p)=>n+p.candles.length,0),cas:new Set(inputs.map(p=>p.symbol.ca)).size,pools:inputs.length,gapBuckets:gaps,
   missingSignalCas:[...new Set(inputs.filter(p=>!known.has(caKey(p.symbol))).map(p=>p.symbol.ca))],
   noDataPools:(metadata.poolInventory??[]).filter(p=>!present.has(poolKey({chain:p.chain,ca:p.ca,pairId:p.pair_id}))),
   firstTime:Math.min(...inputs.map(p=>p.candles[0].time)),lastTime:Math.max(...inputs.map(p=>p.candles.at(-1).time))};
  loadedInterval=interval;await saveJson(resolve(output,'coverage.json'),coverage);console.log(JSON.stringify({stage:'loaded',interval,...Object.fromEntries(Object.entries(coverage[interval]).filter(([k])=>!['missingSignalCas','noDataPools'].includes(k)))}));return inputs;
 }
 // Serialize atomic writes: parallel results must never race on the same .tmp file.
 let saving=Promise.resolve();
 const flush=()=>{const state={protocolHash,rows:[...cached.values()].sort((a,b)=>a.id.localeCompare(b.id))};saving=saving.then(()=>saveJson(progressPath,state));return saving;};
 async function runAll(list){
  for(const interval of intervals){const pending=list.filter(c=>c.interval===interval&&!cached.has(c.id));if(!pending.length)continue;await load(interval);
   const selected=pending.slice(0,Math.max(0,maxRuns-runs));let cursor=0;
   const record=async r=>{cached.set(r.id,r);runs++;
    console.log(JSON.stringify({stage:'evaluate',id:r.id,done:cached.size,netReturn:r.accountReturn,trades:r.totalTrades,seconds:r.seconds,rssMiB:process.memoryUsage().rss/1048576}));if(runs%50===0)await flush();};
   if(workers===1){for(const c of selected){await record(evaluate(c,inputs,signals,asOf));await new Promise(r=>setImmediate(r));}}
   else{
    const active=[];
    try{await Promise.all(Array.from({length:Math.min(workers,selected.length)},()=>new Promise((resolve,reject)=>{
     const w=new Worker(new URL(import.meta.url),{workerData:{snapshot,manifest,signals,asOf,interval}});active.push(w);
     const next=()=>{const c=selected[cursor++];if(c)w.postMessage(c);else resolve();};
     w.on('error',reject);w.on('exit',code=>{if(code!==0)reject(new Error(`Research worker exited ${code}`));});
     w.on('message',async message=>{try{if(message.ready){next();return;}if(message.error)throw Error(message.error);await record(message.result);next();}catch(e){reject(e);}});
    })));}finally{await Promise.all(active.map(w=>w.terminate()));await flush();}
   }
   if(selected.length<pending.length){await flush();return false;}
  }await flush();return true;
 }
 if(!await runAll(candidates))return {complete:false,done:cached.size};
 const refined=secondRound(candidates,candidates.map(c=>cached.get(c.id)),refine,seed);await saveJson(resolve(output,'round2.json'),{protocolHash,candidates:refined});
 const all=[...candidates,...refined],byId=new Map(all.map(c=>[c.id,c]));for(const id of cached.keys())assert(byId.has(id),'Unexpected cached candidate');
 if(!await runAll(refined))return {complete:false,done:cached.size};
 const leaders=ranking([...cached.values()]).slice(0,10),details=[];
 for(const [index,row] of leaders.entries()){
  const candidate=byId.get(row.id);await load(candidate.interval);const raw=resolve(output,row.id+'.details.jsonl'),fd=openSync(raw+'.tmp','w');let replay;
  try{replay=evaluate(candidate,inputs,signals,asOf,batch=>writeSync(fd,JSON.stringify(batch)+'\n'));}finally{closeSync(fd);}
  sameReplay(row,replay);await rename(raw+'.tmp',raw);
  // One full replay is streamed at a time; final artifacts are compressed, never multiplied input snapshots.
  await pipeline(createReadStream(raw),createGzip(),createWriteStream(raw+'.gz.tmp'));await rename(raw+'.gz.tmp',raw+'.gz');await unlink(raw);
  const record={...row,config:candidate.config,description:generateStrategyDescription(candidate.config),detailsFile:row.id+'.details.jsonl.gz'};
  if(index<3){const stressed=structuredClone(candidate);stressed.config.executionConfig.slippagePercent=2;record.stress=evaluate(stressed,inputs,signals,asOf);
   const rest=inputs.filter(p=>caKey(p.symbol)!==row.bestCa?.key);record.withoutBestCa=row.bestCa&&rest.length?evaluate(candidate,rest,signals,asOf):null;
  }
  details.push(record);await saveJson(resolve(output,'leaders.partial.json'),details);
 }
 for(const interval of intervals)await load(interval);
 const report={protocolHash,snapshotHash:checksum,engineVersion:ENGINE_VERSION,scope:protocol.warning,asOf,candidates:all.length,profitable:[...cached.values()].filter(r=>r.totalTrades>0&&r.accountReturn>0).length,coverage,leaders:details,completedAt:new Date().toISOString()};
 await saveJson(resolve(output,'report.json'),report);await writeFile(resolve(output,'report.md'),reportMarkdown(report));console.log(JSON.stringify({stage:'complete',candidates:all.length,profitable:report.profitable,best:leaders[0]?.accountReturn}));return report;
}
if(!isMainThread){
 const {snapshot,manifest,signals,asOf,interval}=workerData;
 const loaded=await loadInputs(snapshot,manifest,'sol',interval);
 const inputs=loaded.inputs.map(p=>({...p,candles:p.candles.filter(c=>c.time<asOf&&c.closeTime<=asOf)})).filter(p=>p.candles.length);
 parentPort.on('message',candidate=>{try{parentPort.postMessage({result:evaluate(candidate,inputs,signals,asOf)});}catch(e){parentPort.postMessage({error:e.stack??String(e)});}});parentPort.postMessage({ready:true});
}else if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const [snapshot,output,workers='4']=process.argv.slice(2);assert(snapshot&&output,'Usage: SNAPSHOT OUTPUT [WORKERS=4]');await research({snapshot,output,workers:Number(workers)});}
