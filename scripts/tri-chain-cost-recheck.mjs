/** Re-evaluate a frozen candidate on exactly the same CA groups with the current fixed cost policy. */
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ENGINE_VERSION} from '../packages/engine/dist/index.js';
import {hash,fileHash,saveJson} from './cohort-snapshot.mjs';
import {loadInputs,earliestSignals,evaluateCohort,median} from './cohort-research.mjs';
import {RESEARCH_COSTS} from './tri-chain-stability.mjs';

const read=async path=>JSON.parse(await readFile(path,'utf8'));
export async function recheckCosts({snapshot,study,chain,candidateId,output}){
 assert(snapshot&&study&&chain&&candidateId&&output,'SNAPSHOT STUDY CHAIN CANDIDATE OUTPUT required');
 snapshot=resolve(snapshot);study=resolve(study);
 const manifest=await read(resolve(snapshot,'manifest.json')),{checksum,...unsigned}=manifest;
 assert.equal(hash(unsigned),checksum,'Snapshot manifest changed');assert.equal(manifest.engineVersion,ENGINE_VERSION);
 assert.equal(await fileHash(resolve(snapshot,'metadata.json')),manifest.metadataHash);
 const metadata=await read(resolve(snapshot,'metadata.json'));
 const protocol=await read(resolve(study,chain,'protocol.json')),report=await read(resolve(study,chain,'report.json'));
 assert.equal(report.protocolHash,hash(protocol),'Research protocol changed');
 assert.equal(protocol.snapshotHash,manifest.checksum,'Research and snapshot differ');
 const source=protocol.candidates.find(x=>x.id===candidateId);assert(source,'Unknown candidate');
 assert.equal(source.config.entryAfterSignal,true,'Signal gate is required');
 const candidate=structuredClone(source);Object.assign(candidate.config.executionConfig,RESEARCH_COSTS);
 const {inputs}=await loadInputs(snapshot,manifest,chain,candidate.interval);
 const signals=earliestSignals(metadata.token_info.filter(x=>x.chain===chain));
 const groups=[[1],[2],[3],[4],[5],[6],[7],[4,5,6,7],[1,2,3,4,5,6,7]];
 const results=groups.map(folds=>evaluateCohort(candidate,inputs,signals,candidate.interval,folds,protocol.partition));
 const small=results.slice(0,6),middle=median(small.map(x=>x.accountReturn));
 const assessment={allSixProfitable:small.every(x=>x.accountReturn>0),allSixAtLeastTenTrades:small.every(x=>x.totalTrades>=10),allSixDrawdownWithinTen:small.every(x=>x.accountMaxDrawdown<=10),
  medianSmallReturn:middle,maxRelativeDeviation:middle>0?Math.max(...small.map(x=>Math.abs(x.accountReturn-middle)/middle)):null,
  reservePositive:results[6].accountReturn>0,independentLargePositive:results[7].accountReturn>0,fullPositive:results[8].accountReturn>0};
 const result={kind:'tri-chain-cost-recheck-v1',chain,candidateId,interval:candidate.interval,sourceSnapshotHash:manifest.checksum,sourceProtocolHash:hash(protocol),
  originalCosts:source.config.executionConfig,executionConfig:candidate.config.executionConfig,partition:protocol.partition,assessment,results,completedAt:new Date().toISOString()};
 output=resolve(output);await mkdir(dirname(output),{recursive:true});await saveJson(output,result);return result;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [snapshot,study,chain,candidateId,output]=process.argv.slice(2);
 const r=await recheckCosts({snapshot,study,chain,candidateId,output});
 console.log(JSON.stringify({candidateId:r.candidateId,small:r.results.slice(0,6).map(x=>x.accountReturn),reserve:r.results[6].accountReturn,independentLarge:r.results[7].accountReturn,full:r.results[8].accountReturn,assessment:r.assessment}));
}
