import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {splitSmallSets} from './small-set-research.mjs';
import {judge,eligibleForBoth,RESEARCH_COSTS} from './tri-chain-stability.mjs';
import {replayCandidates} from './cohort-server-verify.mjs';
import {dataHash,reuseSnapshot} from './cohort-snapshot-reuse.mjs';
import {fileHash,hash} from './cohort-snapshot.mjs';
const day=86400000;
test('all new chain validations use the same per-side fees, slippage and taxes',()=>{
 assert.deepEqual(RESEARCH_COSTS,{feePercent:1,slippagePercent:1,buyTaxPercent:1,sellTaxPercent:1});
});
test('six groups plus reserve are deterministic, day balanced and CA disjoint',()=>{
 const signals=Array.from({length:420},(_,i)=>({chain:'bsc',ca:`c${i}`,signalTime:Date.UTC(2026,8,5)+i%14*day}));
 const a=splitSmallSets(signals,20260924,25,6,10),b=splitSmallSets([...signals].reverse(),20260924,25,6,10);
 assert.deepEqual(a,b);assert.equal(a.sets.length,6);assert.equal(a.reserve,270);assert.equal(new Set(a.entries.map(s=>s.ca)).size,420);
 assert(a.sets.every(s=>s.count===25));assert(a.entries.filter(s=>s.fold===7).length===270);
});
test('eligibility requires the same CA to have post-signal candles in both intervals',()=>{
 const signals=[{chain:'sol',ca:'A',signalTime:100},{chain:'sol',ca:'B',signalTime:100}];
 const symbol=ca=>({chain:'sol',ca,pairId:ca}),pool=(ca,times)=>({symbol:symbol(ca),candles:times.map(time=>({time}))});
 assert.deepEqual(eligibleForBoth(signals,{'30s':[pool('A',[0,101]),pool('B',[0,101])],'1m':[pool('A',[0,101]),pool('B',[0,100])]}),[signals[0]]);
});
test('a profitable full account does not mask weak groups, insufficient reserve or concentration',()=>{
 const good={accountReturn:2,totalTrades:10,accountMaxDrawdown:5},groups=Array(6).fill(good);
 assert(judge(groups,good,good,good,good,good).pass);
 assert(!judge(groups.map((x,i)=>i===2?{...x,accountReturn:0}:x),good,good,good,good,good).pass);
 assert(!judge([...groups.slice(0,5),{...good,accountReturn:4}],good,good,good,good,good).pass);
 assert(!judge(groups,{...good,totalTrades:9},good,good,good,good).pass);
 assert(!judge(groups,good,good,good,{...good,accountReturn:-1},good).pass);
 assert(!judge(groups,good,good,good,good,{...good,accountReturn:-1}).pass);
 assert(!judge(groups,good,good,good,null,null).pass);
});
test('server replay only accepts passing candidates and covers all acceptance cohorts',()=>{
 const result={id:'x',pass:true,assessment:{pass:true},config:{entryAfterSignal:true},development:[1,2,3].map(accountReturn=>({accountReturn,audit:{tradeHash:'a',signalHash:'b'}})),validation:[4,5,6].map(accountReturn=>({accountReturn,audit:{tradeHash:'a',signalHash:'b'}})),reserve:{audit:{tradeHash:'a',signalHash:'b'}},large:{audit:{tradeHash:'a',signalHash:'b'}},full:{audit:{tradeHash:'a',signalHash:'b'}}};
 const report={kind:'tri-chain-stability-v1',uploadCandidates:['x'],results:[result]},protocol={kind:report.kind,candidates:[{id:'x',interval:'30s',config:result.config}]};
 const replays=replayCandidates(report,protocol)[0].replays;assert.deepEqual(replays.map(x=>x.folds),[[1],[2],[3],[4],[5],[6],[7],[4,5,6,7],[1,2,3,4,5,6,7]]);
 assert.throws(()=>replayCandidates({...report,results:[{...result,pass:false}]},protocol));
});
test('fresh snapshot may reuse only verified identical row content',async t=>{
 const root=await mkdtemp(join(tmpdir(),'meme-snapshot-reuse-'));t.after(async()=>{const {rm}=await import('node:fs/promises');await rm(root,{recursive:true,force:true});});
 const oldDir=join(root,'old'),newDir=join(root,'verified');await mkdir(oldDir);
 const rows='["ca","pair",1,2,1,2,1,2,3,true]\n',file='sol-30s-mcap.jsonl.gz';
 await writeFile(join(oldDir,file),gzipSync(rows));await writeFile(join(root,'metadata.json'),'{}');
 const prior={version:1,files:[{name:file,chain:'sol',interval:'30s',type:'mcap',rows:1,valid:1,sha256:await fileHash(join(oldDir,file)),dataHash:await dataHash(join(oldDir,file))}]};prior.checksum=hash(prior);await writeFile(join(oldDir,'manifest.json'),JSON.stringify(prior));
 const remote={...prior,files:prior.files.map(f=>({...f,sha256:'different-gzip-header'})),metadataHash:await fileHash(join(root,'metadata.json'))};delete remote.checksum;remote.checksum=hash(remote);
 await writeFile(join(root,'remote.json'),JSON.stringify(remote));
 const local=await reuseSnapshot(join(root,'remote.json'),join(root,'metadata.json'),oldDir,newDir);
 assert.equal(local.sourceSnapshotChecksum,remote.checksum);assert.equal(local.files[0].sha256,prior.files[0].sha256);
 assert.equal((await readFile(join(newDir,'manifest.json'),'utf8')).includes(remote.checksum),true);
 const changed={...remote,files:remote.files.map(f=>({...f,dataHash:'changed'}))};delete changed.checksum;changed.checksum=hash(changed);
 await writeFile(join(root,'changed.json'),JSON.stringify(changed));
 await assert.rejects(()=>reuseSnapshot(join(root,'changed.json'),join(root,'metadata.json'),oldDir,join(root,'rejected')),/dataHash changed/);
});
