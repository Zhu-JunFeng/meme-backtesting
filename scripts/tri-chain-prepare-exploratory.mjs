/** Build a narrowly scoped, explicitly authorized replay manifest for an unqualified candidate. */
import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash,saveJson} from './cohort-snapshot.mjs';
import {RESEARCH_COSTS} from './tri-chain-stability.mjs';

const read=async path=>JSON.parse(await readFile(path,'utf8'));
async function immutable(path,value){try{assert.deepEqual(await read(path),value,'Existing frozen submission differs');}catch(e){if(e.code!=='ENOENT')throw e;await saveJson(path,value);}}
export async function prepareExploratory({study,costRecheck,output,explicitAuthorization=false}){
 assert.equal(explicitAuthorization,true,'Explicit authorization is required for an unqualified candidate');
 const checked=await read(resolve(costRecheck)),chain=checked.chain,id=checked.candidateId;
 assert.equal(checked.kind,'tri-chain-cost-recheck-v1');
 const oldProtocol=await read(resolve(study,chain,'protocol.json')),oldReport=await read(resolve(study,chain,'report.json'));
 assert.equal(oldReport.protocolHash,hash(oldProtocol));assert.equal(checked.sourceProtocolHash,hash(oldProtocol));
 assert.equal(checked.sourceSnapshotHash,oldProtocol.snapshotHash);
 const original=oldProtocol.candidates.find(c=>c.id===id),finding=oldReport.results.find(r=>r.id===id);
 assert(original&&finding&&finding.pass===false&&finding.assessment?.pass===false,'Candidate must be the explicitly reviewed unqualified result');
 assert.deepEqual(checked.originalCosts,original.config.executionConfig);
 assert.deepEqual(Object.fromEntries(Object.keys(RESEARCH_COSTS).map(k=>[k,checked.executionConfig[k]])),RESEARCH_COSTS);
 assert.equal(checked.results.length,9);assert.deepEqual(checked.results[8].foldIds,[1,2,3,4,5,6,7]);
 const candidate=structuredClone(original);Object.assign(candidate.config.executionConfig,RESEARCH_COSTS);
 assert.deepEqual(candidate.config.executionConfig,checked.executionConfig);
 const scope='用户明确要求上传探索策略复验；该候选未达到六个小集合稳定盈利标准。手续费、单边滑点和买卖税均为每侧 1%，严禁标作稳定达标策略。';
 const protocol={version:1,kind:'tri-chain-exploratory-cost-v1',chain,snapshotHash:oldProtocol.snapshotHash,engineVersion:oldProtocol.engineVersion,
  sourceProtocolHash:hash(oldProtocol),costRecheckHash:hash(checked),partition:oldProtocol.partition,scope,candidates:[candidate]};
 const report={kind:protocol.kind,chain,snapshotHash:protocol.snapshotHash,protocolHash:hash(protocol),scope,uploadCandidates:[id],
  results:[{id,config:candidate.config,pass:false,sourceAssessment:finding.assessment,full:checked.results[8]}]};
 output=resolve(output);await mkdir(output,{recursive:true});
 await immutable(resolve(output,'protocol.json'),protocol);await immutable(resolve(output,'report.json'),report);
 return {protocol,report};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 const [study,costRecheck,output,flag]=process.argv.slice(2);
 const r=await prepareExploratory({study,costRecheck,output,explicitAuthorization:flag==='--explicit-exploratory'});
 console.log(JSON.stringify({chain:r.report.chain,candidate:r.report.uploadCandidates[0],protocolHash:r.report.protocolHash,scope:r.report.scope}));
}
