/** Local-only exploratory search. Reused windows are NOT blind validation. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertLocalDatabase,evaluateWindow} from './offline-strategy-research.mjs';
import {validCandle,poolKey,ENGINE_VERSION} from '../packages/engine/dist/index.js';
import {validateProfitLock} from '../packages/domain/dist/index.js';

const clone=structuredClone;
const strategyKeys=['schemaVersion','minimumSignalAgeMinutes','impulseCondition','entryConditionGroup','invalidationConditionGroup','addConditionGroup','exitConfig','positionConfig','executionConfig'];
const strategy=c=>Object.fromEntries(strategyKeys.filter(k=>k in c).map(k=>[k,clone(c[k])]));
export function candidatesAround(bases,count=256,seed=20260922){
 assert(Number.isInteger(count)&&count>=bases.length&&count<=5000);assert(bases.length);
 let rng=seed>>>0;const pick=a=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return clone(a[Math.floor(rng/4294967296*a.length)]);};
 const out=[],seen=new Set();
 const add=c=>{c=strategy(c);const key=JSON.stringify(c);if(seen.has(key)||out.length>=count)return;seen.add(key);assert.equal(validateProfitLock(c.exitConfig.profitLock),undefined);assert.equal(c.positionConfig.sizing.type,'fixed_percent');out.push({id:`E${String(out.length+1).padStart(4,'0')}`,config:c});};
 const stops=[10,15,20,30,40].map(value=>({type:'percent',value})).concat([{type:'fib_level',ratio:.886,bufferPercent:2},{type:'swing_low',bufferPercent:2}]);
 const targets=[2,3,4,6].map(ratio=>({type:'risk_reward',ratio})).concat([50,100,200].map(value=>({type:'percent',value})),[{type:'previous_high'}]);
 const locks=[{enabled:false,tiers:[]},...[[[20,5],[50,20]],[[30,10],[80,40]],[[50,20],[100,60]],[[80,40],[150,100]]].map(t=>({enabled:true,tiers:t.map(([activationPercent,floorPercent])=>({activationPercent,floorPercent}))}))];
 const zones=[[.382,.618],[.5,.65],[.5,.786],[.618,.65],[.618,.786],[.65,.886],[.786,.886]];
 const rsi=period=>({type:'rsi_recovery',period,oversold:30,recovery:35});
 const ema=period=>({type:'ema_reclaim',period});
 const obv=lookbackBars=>({type:'obv_confirmation',lookbackBars,minChangePercent:0});
 const pattern={type:'candle_pattern',patterns:['hammer','bullish_engulfing','pin_bar','long_lower_wick']};
 const any=(...conditions)=>({mode:'any',conditions});
 const confirmations=[null,any(rsi(14),ema(21),obv(10)),any(rsi(7),ema(9)),any(pattern,{type:'bullish_volume_confirmation',period:10,minRatio:1.5}),rsi(14),ema(9),ema(21),obv(10),{type:'volume_contraction',period:10,maxRatio:.7},pattern,{mode:'at_least',minMatches:2,conditions:[rsi(14),ema(9),obv(10),pattern]}];
 const entry=(zone,confirmation)=>({mode:'all',conditions:[{type:'fib_retracement',zoneLow:zone[0],zoneHigh:zone[1]},...(confirmation?[confirmation]:[])]});
 bases.forEach(add);
 // One-factor neighborhoods preserve interpretable comparisons with the previous leaders.
 for(const base of bases){
  const mutations=[
   ...[50,80,120,150,200].map(v=>c=>{c.impulseCondition.minGainPercent=v;}),
   ...[2,3,5].map(v=>c=>{c.impulseCondition.leftBars=v;c.impulseCondition.rightBars=v;}),
   ...[60,150,300].map(v=>c=>{c.impulseCondition.lookbackBars=v;c.impulseCondition.maxDurationBars=Math.min(v,c.impulseCondition.maxDurationBars);}),
   ...[20,60,100].map(v=>c=>{c.impulseCondition.maxDurationBars=v;c.impulseCondition.lookbackBars=Math.max(v,c.impulseCondition.lookbackBars);}),
   ...zones.map(v=>c=>{c.entryConditionGroup=entry(v,confirmations[1]);}),
   ...confirmations.map(v=>c=>{c.entryConditionGroup=entry([.618,.786],v);}),
   ...stops.map(v=>c=>{c.exitConfig.stopLoss=clone(v);}),...targets.map(v=>c=>{c.exitConfig.takeProfit=clone(v);}),
   ...locks.map(v=>c=>{c.exitConfig.profitLock=clone(v);}),
   ...[30,60,180,240,480].map(v=>c=>{c.exitConfig.maxHoldingBars=v;}),
   ...[2,3].map(v=>c=>{c.positionConfig.maxConcurrentPositions=v;}),
   ...[2,3].map(v=>c=>{c.positionConfig.sizing.value=v;}),
   c=>{c.positionConfig.allowReentry=false;},
   c=>{c.impulseCondition.requireVolumeExpansion=true;c.impulseCondition.volumeExpansionRatio=1.5;}
  ];
  for(const mutate of mutations){const c=clone(base);mutate(c);add(c);}
 }
 while(out.length<count){
  const c=pick(bases),pivot=pick([2,3,5]);Object.assign(c.impulseCondition,{leftBars:pivot,rightBars:pivot,lookbackBars:pick([100,200,300]),minGainPercent:pick([50,80,100,150,200]),maxDurationBars:pick([20,30,60,100]),requireVolumeExpansion:pick([false,false,true]),volumeExpansionRatio:pick([1.2,1.5,2])});
  c.entryConditionGroup=entry(pick(zones),pick(confirmations));
  if(pick([false,false,false,true]))c.entryConditionGroup.conditions[0]={type:'percent_retracement',minPercent:20,maxPercent:pick([40,50,60])};
  Object.assign(c.exitConfig,{stopLoss:pick(stops),takeProfit:pick(targets),maxHoldingBars:pick([30,60,120,240,480]),profitLock:pick(locks),closeAtEnd:true});
  Object.assign(c.positionConfig,{mode:'single_entry',maxEntries:1,maxConcurrentPositions:pick([1,1,2,3]),allowReentry:pick([true,true,false]),sizing:{type:'fixed_percent',value:pick([1,1,2,3])}});
  c.addConditionGroup={mode:'all',enabled:false,conditions:[]};add(c);
 }
 return out;
}

export const foldEligible=r=>r.accountReturn>=0&&r.normalReturn>=0&&r.accountMaxDrawdown<=10&&r.normalTrades>=20;
export const targetReached=folds=>folds.length===3&&folds.every(r=>foldEligible(r)&&r.accountReturn>=5&&r.normalReturn>=5);
export const accountEligible=r=>Number.isFinite(r.accountReturn)&&r.accountReturn>=0&&r.accountMaxDrawdown<=10&&r.totalTrades>=20;
export const accountTargetReached=folds=>folds.length===3&&folds.every(r=>accountEligible(r)&&r.accountReturn>=5);

export async function explore({chain,interval,output,root=process.cwd(),count=256,terminalClose=false}){
 assert(['sol','robin'].includes(chain));assert(['30s','1m'].includes(interval));
 const read=async p=>JSON.parse(await readFile(resolve(root,p),'utf8'));
 const manifest=await read('output/local-market-data/manifest.json');assert(manifest.verifiedAt);assertLocalDatabase(manifest.local);
 const prior=await read(`output/research-stable5-20260921/${chain}/protocol.json`),bounds=prior.boundaries.map(Date.parse);
 assert(bounds.length===4&&bounds.every((t,i)=>Number.isFinite(t)&&(!i||t>bounds[i-1])));
 const bases=terminalClose?[
  (await read(`output/research-stable5-20260921/round2/${chain}-candidate-research-only.json`)).strategy,
  (await read(`output/research-stable5-20260921/${chain}-candidate.json`)).strategy
 ]:await Promise.all([chain,chain==='sol'?'robin':'sol'].map(async ch=>(await read(`output/research-stable5-20260921/${ch}-candidate.json`)).strategy));
 const seed=terminalClose?20260924:20260922,candidates=candidatesAround(bases,count,seed),step=interval==='30s'?30000:60000,warmupBars=terminalClose?0:1500;
 for(const c of candidates)c.config.exitConfig.closeAtEnd=true;
 const eligible=terminalClose?accountEligible:foldEligible,passed=terminalClose?accountTargetReached:targetReached,score=r=>terminalClose?r.accountReturn:Math.min(r.accountReturn,r.normalReturn);
 const checkEnd=terminalClose?Date.parse(chain==='sol'?'2026-09-19T17:00:00Z':'2026-09-21T09:00:00Z'):bounds[3];
 await mkdir(output,{recursive:true});
 const protocol={scope:'Exploratory optimization on previously inspected windows; NOT blind out-of-sample validation. No production access.',chain,interval,valueType:'mcap',boundaries:prior.boundaries,warmupBars,seed,candidates,engineVersion:ENGINE_VERSION,archiveSha256:manifest.archive.sha256,createdAt:new Date().toISOString(),terminalClose,checkWindow:terminalClose?{from:new Date(bounds[3]).toISOString(),toExclusive:new Date(checkEnd).toISOString(),note:'Shorter historical fragment, previously inspected for other candidates; not a fresh blind test.'}:undefined,selection:terminalClose?'Full account return INCLUDING terminal exits. First-fold gate: return >=0, drawdown <=10%, total closed trades >=20. Rank three-fold minimum account return. No warm-up; last available candle close liquidates each pool.':'Evaluate fold 0 for all; evaluate folds 1 and 2 only if fold 0 has both returns >=0, drawdown <=10%, normal trades >=20. Rank completed candidates by minimum return over all folds and both accounting views.',target:terminalClose?'Account return >=5%, max drawdown <=10%, >=20 total closed trades, in each full fold. Normal-only return is diagnostic, never a ranking gate.':'Both returns >=5%, max drawdown <=10%, >=20 normal trades, in every fold. No leverage or cost reduction.'};
 await writeFile(resolve(output,'protocol.json'),JSON.stringify(protocol,null,2),{flag:'wx'});
 const save=async(name,data)=>{const p=resolve(output,name+'.json');await writeFile(p+'.tmp',JSON.stringify(data,null,2));await rename(p+'.tmp',p);};
 const require=createRequire(new URL('../apps/api/package.json',import.meta.url)),{Client}=require('pg'),db=new Client({...manifest.local,application_name:'local-neighborhood-exploration'});
 const inputs=[];try{await db.connect();await db.query('BEGIN READ ONLY');const rows=(await db.query('SELECT ca,pair_id,open_time::float8 AS time,close_time::float8 AS "closeTime",open::float8,high::float8,low::float8,close::float8,volume::float8 FROM public.meme_kline WHERE chain=$1 AND interval=$2 AND type=$3 AND valid IS NOT FALSE AND open_time >= $4 AND open_time < $5 ORDER BY ca,pair_id,open_time',[chain,interval,'mcap',bounds[0]-warmupBars*step,checkEnd])).rows;
  const pools=new Map();for(const r of rows){const symbol={chain,ca:r.ca,pairId:r.pair_id},key=poolKey(symbol),candle={time:r.time,closeTime:r.closeTime,open:r.open,high:r.high,low:r.low,close:r.close,volume:r.volume,valid:true};if(!validCandle(candle))continue;if(!pools.has(key))pools.set(key,{symbol,candles:[]});pools.get(key).candles.push(candle);}inputs.push(...pools.values());await db.query('COMMIT');
 }finally{await db.end();}assert(inputs.length);
 const hash=createHash('sha256');for(const p of inputs)hash.update(JSON.stringify(p));await save('dataset',{hash:hash.digest('hex'),pools:inputs.length,cas:new Set(inputs.map(p=>p.symbol.ca)).size,candles:inputs.reduce((n,p)=>n+p.candles.length,0)});
 const log=data=>console.log(JSON.stringify({at:new Date().toISOString(),chain,interval,...data}));
 const run=(candidate,fold)=>evaluateWindow(candidate,inputs,bounds[fold],bounds[fold+1],{interval,valueType:'mcap',warmupBars});
 const trials=[];let runs=0;
 for(const c of candidates){
  const folds=[run(c,0)];runs++;if(eligible(folds[0])){folds.push(run(c,1),run(c,2));runs+=2;}
  const trial={id:c.id,folds,complete:folds.length===3,pass:passed(folds),worstReturn:Math.min(...folds.map(score)),config:c.config};trials.push(trial);
  await save('trials',trials);if(trials.length%10===0||trial.pass)log({stage:'exploring',done:trials.length,total:candidates.length,runs,passing:trials.filter(r=>r.pass).length});await new Promise(r=>setImmediate(r));
 }
 const leaders=trials.filter(r=>r.complete).sort((a,b)=>Number(b.folds.every(eligible))-Number(a.folds.every(eligible))||b.worstReturn-a.worstReturn).slice(0,10);
 if(terminalClose)for(const c of leaders){c.laterFragment=evaluateWindow(c,inputs,bounds[3],checkEnd,{interval,valueType:'mcap',warmupBars:0});runs++;await save('leaders-check',leaders);}
 const stress=[];for(const leader of leaders.slice(0,3)){
  const variants=[['slippage_plus_1pp',c=>{c.executionConfig.slippagePercent+=1;}],['impulse_gain_minus_10pct',c=>{c.impulseCondition.minGainPercent*=.9;}],['impulse_gain_plus_10pct',c=>{c.impulseCondition.minGainPercent*=1.1;}],['holding_minus_20pct',c=>{c.exitConfig.maxHoldingBars=Math.round(c.exitConfig.maxHoldingBars*.8);}]];
  for(const [name,mutate] of variants){const c=clone(leader);mutate(c.config);const folds=[0,1,2].map(f=>run(c,f));runs+=3;stress.push({id:leader.id,name,folds,pass:passed(folds)});await save('stress',stress);}
 }
 const result={chain,interval,valueType:'mcap',terminalClose,warmupBars,scope:protocol.scope,completedAt:new Date().toISOString(),candidates:candidates.length,runs,complete:trials.filter(r=>r.complete).length,passed:trials.filter(r=>r.pass).length,allPositiveWithinRisk:trials.filter(r=>r.complete&&r.folds.every(eligible)).length,leaders,stress};await save('results',result);log({stage:'complete',runs,passed:result.passed,best:leaders[0]?.worstReturn});return result;
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [chain,interval,output,mode]=process.argv.slice(2);assert(output,'Usage: node scripts/explore-strategy-neighborhood.mjs sol|robin 30s|1m NEW_OUTPUT_DIRECTORY [terminal-close]');assert(mode===undefined||mode==='terminal-close','Unknown mode');await explore({chain,interval,output:resolve(output),terminalClose:mode==='terminal-close',count:mode==='terminal-close'?192:256});
}
