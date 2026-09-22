/** Offline research only: never connects to the production API or writes backtests. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ResumableEngine,validCandle,poolKey,ENGINE_VERSION} from '../packages/engine/dist/index.js';

export function assertLocalDatabase(options){
 if(options.connectionString)throw Error('禁止使用可覆盖本地主机的 connectionString');
 const host=options.host;
 if(typeof host!=='string'||!['localhost','127.0.0.1','::1'].includes(host)&&!host.startsWith('/'))throw Error('研究工具只允许本机 PostgreSQL / Unix socket，禁止远程数据库');
}

export function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,canonical(value[k])]));return value;}
export const ledgerHash=rows=>createHash('sha256').update(rows.map(r=>JSON.stringify(canonical(r))).sort().join('\n')).digest('hex');

/** Gap semantics match FrozenReader; only the previous close fills a gap. */
export class LocalCandleReader{
 constructor(input,from,to,step){this.symbol=input.symbol;this.rows=input.candles.filter(c=>c.time>=from&&c.time<to);this.i=0;this.previous=undefined;this.step=step;}
 peek(){const raw=this.rows[this.i];if(!raw)return;
  if(this.previous&&this.previous.time+this.step<raw.time){const time=this.previous.time+this.step,close=this.previous.close;return{symbol:this.symbol,candle:{time,closeTime:time+this.step,open:close,high:close,low:close,close,volume:0,synthetic:true,valid:true},last:false};}
  return{symbol:this.symbol,candle:raw,last:this.i===this.rows.length-1};
 }
 consume(c){this.previous=c;if(!c.synthetic)this.i++;}
}

export function evaluateWindow(candidate,inputs,from,to,{interval='30s',valueType='mcap',warmupBars=1500,detail=false}={}){
 assert(['30s','1m'].includes(interval));assert(['price','mcap'].includes(valueType));assert(Number.isFinite(from)&&to>from);
 const step=interval==='30s'?30000:60000,started=performance.now(),config=structuredClone(candidate.config);
 config.symbols=inputs.map(p=>p.symbol);config.interval=interval;config.valueType=valueType;config.exitConfig.closeAtEnd=true;
 const capital=config.executionConfig.initialCapital;assert(Number.isFinite(capital)&&capital>0);
 // Build all indicator state before disabling entries during the warm-up.
 const engine=new ResumableEngine(config),entryEnabled=config.entryConditionGroup.enabled;
 config.entryConditionGroup.enabled=false;
 const readers=inputs.map(p=>new LocalCandleReader(p,from-warmupBars*step,to,step)),heads=readers.map(r=>r.peek());
 let enabled=false,normalNet=0,normalTrades=0,wins=0,excludedNet=0,excludedCount=0;
 const byCa=new Map();
 const allByCa=new Map(),auditTrades=[],auditSignals=[];
 const gates=new Map((config.entrySignals??[]).map(s=>[`${s.chain}:${s.ca}`,s.signalTime]));
 let fees=0,slippageCost=0,taxCost=0,tradeReturnSum=0,tradeReturnCount=0,buyEvents=0;
 const drain=()=>{const batch=engine.drain();if(detail)for(const s of batch.signals){
  auditSignals.push(s);if(s.type==='entry'||s.type==='add'){buyEvents++;assert(s.time>gates.get(`${s.symbol.chain}:${s.symbol.ca}`),'Entry before or at monitoring signal');}
 }
 for(const t of batch.trades){
  if(detail){auditTrades.push(t);fees+=t.fees;slippageCost+=t.slippageCost;taxCost+=t.taxCost;
   const key=`${t.symbol.chain}:${t.symbol.ca}`;allByCa.set(key,(allByCa.get(key)||0)+t.netPnl);
   const invested=t.buyAmount+t.buyFees+t.buySlippageCost+t.buyTaxCost;if(invested>0){tradeReturnSum+=t.netPnl/invested*100;tradeReturnCount++;}
  }
  if(t.exitReason==='end_of_backtest'){excludedNet+=t.netPnl;excludedCount++;continue;}
  assert(['take_profit','stop_loss','profit_lock','invalidation','timeout'].includes(t.exitReason));assert(Number.isFinite(t.netPnl));
  normalNet+=t.netPnl;normalTrades++;if(t.netPnl>0)wins++;
  const key=`${t.symbol.chain}:${t.symbol.ca}`;byCa.set(key,(byCa.get(key)||0)+t.netPnl);
 }};
 for(;;){let time=Infinity;for(const h of heads)if(h&&h.candle.time<time)time=h.candle.time;if(!Number.isFinite(time))break;
  if(!enabled&&time>=from){enabled=true;config.entryConditionGroup.enabled=entryEnabled;}
  const ticks=[],indices=[];for(let i=0;i<heads.length;i++)if(heads[i]?.candle.time===time){ticks.push(heads[i]);indices.push(i);}
  engine.step(ticks);for(const i of indices){readers[i].consume(heads[i].candle);heads[i]=readers[i].peek();}
  if(engine.bufferedRows>=2000)drain();
 }
 drain();const r=engine.finish();assert.equal(r.openPositions.length,0);
 const normalReturn=normalNet/capital*100,topCaPnl=Math.max(0,...byCa.values());
 const topCaKey=topCaPnl>0?[...byCa].find(([,pnl])=>pnl===topCaPnl)?.[0]:null;
 const audit=detail?{fees,slippageCost,taxCost,buyEvents,averageTradeReturn:tradeReturnCount?tradeReturnSum/tradeReturnCount:null,byCa:Object.fromEntries(allByCa),tradeHash:ledgerHash(auditTrades),signalHash:ledgerHash(auditSignals)}:undefined;
 return{id:candidate.id,from:new Date(from).toISOString(),toExclusive:new Date(to).toISOString(),accountReturn:r.returnPercent,normalReturn,netPnl:r.netPnl,normalNet,totalTrades:r.totalTrades,accountWinRate:r.totalTrades?r.winRate:null,normalTrades,winRate:normalTrades?wins/normalTrades:null,accountMaxDrawdown:r.maxDrawdownPercent,profitFactor:Number.isFinite(r.profitFactor)?r.profitFactor:null,excludedCount,excludedNet,topCaPnl,topCaKey,withoutBestCaNormalReturn:(normalNet-topCaPnl)/capital*100,syntheticBars:r.dataQuality.syntheticBars,processedBars:engine.s.processed,seconds:(performance.now()-started)/1000,...(detail?{audit}: {})};
}

export async function runResearch({chain,interval='30s',valueType='mcap',manifestPath,protocolPath,output}){
 assert(['sol','robin'].includes(chain));assert(['30s','1m'].includes(interval));assert(['price','mcap'].includes(valueType));
 const manifest=JSON.parse(await readFile(manifestPath,'utf8')),protocol=JSON.parse(await readFile(protocolPath,'utf8'));
 assert(manifest.verifiedAt,'本地行情尚未校验完成');assertLocalDatabase(manifest.local);
 const boundaries=protocol.boundaries.map(Date.parse),candidates=structuredClone(protocol.candidates);
 assert.equal(boundaries.length,4);assert(boundaries.every((x,i)=>Number.isFinite(x)&&(!i||x>boundaries[i-1])));
 assert(Array.isArray(candidates)&&candidates.length>0&&candidates.length<=5000);
 const warmupBars=protocol.warmupBars??1500,step=interval==='30s'?30000:60000;
 assert(Number.isInteger(warmupBars)&&warmupBars>=0&&warmupBars<=10000);
 // Avoid the known first-entry risk_percent sizing discrepancy during research.
 for(const c of candidates){assert.equal(c.config.executionConfig.fillMode,'current_bar_close');assert(['fixed_percent','fixed_amount'].includes(c.config.positionConfig.sizing.type),'风险仓位模型须先修复后才能用于本研究');}
 await mkdir(output,{recursive:true});
 try{await readFile(resolve(output,'protocol.json'));throw Error('输出目录已含研究记录，请选择新的目录，避免覆盖历史结果');}catch(e){if(e.code!=='ENOENT')throw e;}
 const log=x=>console.log(JSON.stringify({at:new Date().toISOString(),chain,interval,valueType,...x}));
 const save=async(name,data)=>{const path=resolve(output,name+'.json');await writeFile(path+'.tmp',JSON.stringify(data,null,2));await rename(path+'.tmp',path);};
 const require=createRequire(new URL('../apps/api/package.json',import.meta.url)),{Client}=require('pg');
 const db=new Client({...manifest.local,application_name:'offline-strategy-research'});const inputs=[];let invalidRows=0;
 try{
  await db.connect();await db.query('BEGIN READ ONLY');
  const rows=(await db.query(`SELECT ca,pair_id,open_time::float8 AS time,close_time::float8 AS "closeTime",open::float8,high::float8,low::float8,close::float8,volume::float8 FROM public.meme_kline WHERE chain=$1 AND interval=$2 AND type=$3 AND valid IS NOT FALSE AND open_time >= $4 AND open_time < $5 ORDER BY ca,pair_id,open_time`,[chain,interval,valueType,boundaries[0]-warmupBars*step,boundaries[3]])).rows;
  const pools=new Map();
  for(const r of rows){const symbol={chain,ca:r.ca,pairId:r.pair_id},key=poolKey(symbol);if(!pools.has(key))pools.set(key,{symbol,candles:[]});
   const candle={time:r.time,closeTime:r.closeTime,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume,valid:true};
   if(validCandle(candle))pools.get(key).candles.push(candle);else invalidRows++;
  }
  inputs.push(...pools.values());await db.query('COMMIT');
 }finally{await db.end();}
 assert(inputs.length,'指定数据集无可用本地行情');
 for(const {config} of candidates){
  config.symbols=inputs.map(p=>p.symbol);config.interval=interval;config.valueType=valueType;
  config.startTime=new Date(boundaries[0]).toISOString();config.endTime=new Date(boundaries[3]-step).toISOString();
  for(const key of ['pools','selection','batch','strategyTemplateId','strategyVersionId'])delete config[key];
 }
 const hash=createHash('sha256');for(const p of inputs)hash.update(JSON.stringify(p));const dataHash=hash.digest('hex');
 await save('protocol',{...protocol,candidates,chain,interval,valueType,engineVersion:ENGINE_VERSION,sourceArchiveSha256:manifest.archive.sha256,dataHash,invalidRows,scope:'Local snapshot, exploratory chronological validation. No production reads or writes. These windows have previously been inspected; do not claim a fresh blind out-of-sample test.',createdAt:new Date().toISOString()});
 log({stage:'local_data_loaded',pools:inputs.length,cas:new Set(inputs.map(p=>p.symbol.ca)).size,candles:inputs.reduce((n,p)=>n+p.candles.length,0),dataHash});
 const evaluate=(c,fold)=>{const r=evaluateWindow(c,inputs,boundaries[fold],boundaries[fold+1],{interval,valueType,warmupBars});return{...r,fold,pass:r.accountReturn>=5&&r.normalReturn>=5&&r.accountMaxDrawdown<=10&&r.normalTrades>=20};};
 const training=[];
 for(const c of candidates){const r=evaluate(c,0);training.push(r);await save('training',training);log({stage:'training',done:training.length,total:candidates.length,...r});await new Promise(r=>setImmediate(r));}
 const ranked=training.filter(r=>r.accountMaxDrawdown<=10&&r.normalTrades>=20).sort((a,b)=>Math.min(b.accountReturn,b.normalReturn)-Math.min(a.accountReturn,a.normalReturn)||a.accountMaxDrawdown-b.accountMaxDrawdown);
 const shortlist=ranked.slice(0,10).map(r=>r.id);await save('shortlist',{ids:shortlist,selectedAt:new Date().toISOString()});
 const validation=[];
 for(const id of shortlist)for(const fold of [1,2]){const r=evaluate(candidates.find(c=>c.id===id),fold);validation.push(r);await save('validation',validation);log({stage:'validation',...r});await new Promise(r=>setImmediate(r));}
 const results=shortlist.map(id=>{const folds=[training.find(r=>r.id===id),...validation.filter(r=>r.id===id)];return{id,pass:folds.length===3&&folds.every(r=>r.pass),worstReturn:Math.min(...folds.map(r=>Math.min(r.accountReturn,r.normalReturn))),folds,config:candidates.find(c=>c.id===id).config};}).sort((a,b)=>b.worstReturn-a.worstReturn);
 const report={chain,interval,valueType,engineVersion:ENGINE_VERSION,dataHash,sourceArchiveSha256:manifest.archive.sha256,completedAt:new Date().toISOString(),candidates:candidates.length,shortlist:shortlist.length,passed:results.filter(r=>r.pass).length,results,trainingLeaders:ranked.slice(0,10)};
 await save('results',report);log({stage:'complete',passed:report.passed,best:results[0]&&{id:results[0].id,worstReturn:results[0].worstReturn}});return report;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [chain,interval='30s',valueType='mcap',output]=process.argv.slice(2);
 if(!chain||!output)throw Error('用法：node scripts/offline-strategy-research.mjs <sol|robin> <30s|1m> <price|mcap> <新输出目录>');
 const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
 await runResearch({chain,interval,valueType,output:resolve(output),manifestPath:process.env.RESEARCH_MANIFEST??resolve(root,'output/local-market-data/manifest.json'),protocolPath:process.env.RESEARCH_PROTOCOL??resolve(root,`output/research-stable5-20260921/${chain}/protocol.json`)});
}
