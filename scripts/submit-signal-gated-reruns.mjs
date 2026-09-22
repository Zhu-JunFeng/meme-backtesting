/** Explicit --submit required. Uses existing production API; never edits old tasks/reports. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
assert(args.includes('--manifest')&&args.includes('--source-runs')&&args.includes('--api')&&args.includes('--output'),'Required: --manifest --source-runs id,id --api --output [--submit]');
const api=get('--api').replace(/\/$/,''),out=resolve(get('--output')),manifest=JSON.parse(await readFile(get('--manifest'),'utf8'));
assert.equal(manifest.version,1);assert.equal(manifest.rule,'bar_open_strictly_after_signal');assert.equal(manifest.history,'available_before_signal');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const manifestHash=hash(manifest),key=x=>JSON.stringify([x.chain,x.ca]);
const signals=new Map(manifest.entries.map(s=>[key(s),s]));assert.equal(signals.size,manifest.entries.length);
async function request(path,body){const response=await fetch(api+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(120000)});if(!response.ok)throw new Error(`${path}: ${response.status} ${await response.text()}`);return response.json();}
const sources=get('--source-runs').split(',');assert.equal(new Set(sources).size,sources.length);
await mkdir(out,{recursive:true});const plans=[];
for(const id of sources){
 const run=await request(`/backtests/${id}`);assert.equal(run.status,'completed');const c=run.config_json;
 const originalRefs=[...new Map(c.symbols.map(s=>[key(s),{chain:s.chain,ca:s.ca}])).values()];
 const excludedMissingSignal=originalRefs.filter(s=>!signals.has(key(s)));
 assert(!excludedMissingSignal.length||args.includes('--exclude-missing-signals'),`Missing external signal: ${JSON.stringify(excludedMissingSignal)}. Explicit --exclude-missing-signals required to omit these projects.`);
 const refs=originalRefs.filter(s=>signals.has(key(s))),selectedSymbols=c.symbols.filter(s=>signals.has(key(s)));assert(refs.length,'No projects with signals');
 const entrySignals=refs.map(s=>{const found=signals.get(key(s));assert(found,`Missing external signal ${key(s)}`);return {...s,signalTime:found.signalTime};});
 const version=await request(`/strategy-versions/${run.strategy_version_id}`);
 for(const field of ['impulseCondition','entryConditionGroup','invalidationConditionGroup','addConditionGroup','exitConfig','positionConfig'])assert.deepEqual(version.strategyJson[field],c[field],`Source/version mismatch: ${field}`);
 const overrides=Object.fromEntries(['initialCapital','feePercent','slippagePercent','buyTaxPercent','sellTaxPercent'].map(k=>[k,c.executionConfig[k]]));
 assert.deepEqual({...version.strategyJson.executionConfig,...overrides},c.executionConfig);
 const name=`信号后入场 · ${run.name} · ${manifestHash.slice(0,8)}`;
 const body={name,strategyVersionId:run.strategy_version_id,dataset:{symbols:selectedSymbols,interval:c.interval,valueType:c.valueType,startTime:c.startTime,endTime:c.endTime,entrySignals,filters:{sourceRunId:id,signalGate:{manifestHash,files:manifest.files,rule:manifest.rule,history:manifest.history,deduplication:manifest.deduplication,excludedMissingSignal}}},executionOverrides:overrides};
 const trades=await request(`/backtests/${id}/trades?includeEndOfBacktest=true`),report=await request(`/backtests/${id}/report`);
 const beforeSignal=trades.filter(t=>signals.has(key(t))&&Number(t.entry_time)<=signals.get(key(t)).signalTime).length;
 const plan={sourceRunId:id,originalConfigHash:hash(c),originalReportHash:hash(report),body,excludedMissingSignal,caCount:refs.length,poolCount:selectedSymbols.length,oldTrades:trades.length,oldTradesBeforeOrAtSignal:beforeSignal,oldTradesWithoutSignal:trades.filter(t=>!signals.has(key(t))).length,signalAfterPoolEnd:(c.pools??[]).filter(p=>p.endTime!==null&&signals.has(key(p))&&signals.get(key(p)).signalTime>=p.endTime).length};plans.push(plan);
 console.log(JSON.stringify({stage:'preview',name,caCount:plan.caCount,poolCount:plan.poolCount,excludedMissingSignal,oldTrades:plan.oldTrades,oldTradesBeforeOrAtSignal:beforeSignal,oldTradesWithoutSignal:plan.oldTradesWithoutSignal,signalAfterPoolEnd:plan.signalAfterPoolEnd}));
}
await writeFile(resolve(out,'plans.json'),JSON.stringify(plans,null,2)+'\n');
if(!args.includes('--submit'))process.exit(0);
// Reconcile by deterministic name before POST. After an uncertain failure rerun this command,
// which checks any created record against the exact snapshot instead of blindly resubmitting.
const submitted=[];
for(const plan of plans){
 const list=await request('/backtests'),matches=list.filter(r=>r.name===plan.body.name);assert(matches.length<=1,'Ambiguous existing run');
 let r;if(matches.length)r=matches[0];else r=await request('/backtests',plan.body);
 const saved=await request(`/backtests/${r.id}`),c=saved.config_json;
 assert.equal(c.selection.filters.signalGate.manifestHash,manifestHash);
 assert.equal(c.selection.filters.sourceRunId,plan.sourceRunId);
 assert.deepEqual([...c.entrySignals].sort((a,b)=>key(a).localeCompare(key(b))),[...plan.body.dataset.entrySignals].sort((a,b)=>key(a).localeCompare(key(b))));
 const row={id:r.id,name:saved.name,sourceRunId:plan.sourceRunId,status:saved.status};submitted.push(row);
 await writeFile(resolve(out,'submitted.json'),JSON.stringify(submitted,null,2)+'\n');console.log(JSON.stringify({stage:'submitted',...row}));
}
