/** Select a single shared candidate using development only; validation never reselects it. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash,saveJson} from './cohort-snapshot.mjs';
import {loadInputs} from './cohort-research.mjs';
import {selectInputs} from './temporal-holdout-research.mjs';
import {gateConfig} from './signal-gated-research.mjs';
import {evaluateWindow} from './offline-strategy-research.mjs';
export function rankShared(rows){
 const chains=['sol','robin','bsc'];
 assert(chains.every(c=>Array.isArray(rows[c])&&rows[c].length),'Missing chain');
 return rows.sol.map(r=>{
  const byChain=Object.fromEntries(chains.map(c=>[c,rows[c].find(x=>x.id===r.id)]));
  assert(Object.values(byChain).every(Boolean),'Missing candidate on a chain');
  const results=Object.values(byChain);
  return {id:r.id,byChain,meanReturn:results.reduce((s,x)=>s+x.accountReturn,0)/3,worstDrawdown:Math.max(...results.map(x=>x.accountMaxDrawdown))};
 }).filter(r=>Object.values(r.byChain).every(x=>Number.isFinite(x.accountReturn)&&Number.isFinite(x.accountMaxDrawdown)&&x.totalTrades>=10&&x.accountMaxDrawdown<=20))
  .sort((a,b)=>b.meanReturn-a.meanReturn||a.worstDrawdown-b.worstDrawdown||a.id.localeCompare(b.id));
}
async function run(root,snapshot,out){
 await mkdir(out,{recursive:true});
 const read=async p=>JSON.parse(await readFile(p,'utf8'));
 const chains=['sol','robin','bsc'],protocols={},development={};
 for(const c of chains){protocols[c]=await read(resolve(root,c,'protocol.json'));development[c]=await read(resolve(root,c,'development.json'));}
 const base=protocols.sol;const manifest=await read(resolve(snapshot,'manifest.json'));
 const {checksum,...unsigned}=manifest;assert.equal(hash(unsigned),checksum);
 for(const p of Object.values(protocols)){assert.deepEqual(p.candidates,base.candidates);assert.deepEqual(p.costs,base.costs);assert.equal(p.snapshotHash,manifest.checksum);assert.equal(p.splitRatio,.5);}
 const ranked=rankShared(development),leader=ranked[0];assert(leader,'No eligible shared candidate');
 const candidate=base.candidates.find(c=>c.id===leader.id);
 const freeze={rule:'Equal initial capital per chain. Maximize mean development return; each chain >=10 trades and <=20% DD. Freeze before validation; no validation-driven reselection. Historical data has been studied before. Not trending-specific performance.',snapshotHash:manifest.checksum,candidate,leader,ranking:ranked};
 try{await writeFile(resolve(out,'selection.json'),JSON.stringify(freeze,null,2),{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;assert.deepEqual(await read(resolve(out,'selection.json')),freeze);}
 console.log('frozen',leader.id,leader.meanReturn);
 const results={};
 for(const chain of chains){
  const p=protocols[chain],loaded=await loadInputs(snapshot,manifest,chain,candidate.interval),signals=[...p.partition.development,...p.partition.validation];
  const evaluate=(ss,end)=>{const inputs=selectInputs(loaded.inputs,ss,end);const from=Math.min(...inputs.map(x=>x.candles[0].time));return evaluateWindow({...candidate,config:gateConfig(candidate.config,inputs,signals)},inputs,from,end,{interval:candidate.interval,warmupBars:0,detail:true});};
  results[chain]={development:leader.byChain[chain],validation:evaluate(p.partition.validation,p.asOf),full:evaluate(signals,p.asOf)};
  await saveJson(resolve(out,chain+'.json'),results[chain]);console.log(chain,JSON.stringify({development:results[chain].development.accountReturn,validation:results[chain].validation.accountReturn,full:results[chain].full.accountReturn}));
 }
 await saveJson(resolve(out,'report.json'),{...freeze,selectionHash:hash(freeze),results,completedAt:new Date().toISOString()});
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){const [root,snapshot,out]=process.argv.slice(2);assert(root&&snapshot&&out);await run(root,snapshot,out);}
