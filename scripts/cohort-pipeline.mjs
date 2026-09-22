/** Bounded workflow: wait for the authorized import, export once, then research locally. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {snapshot,saveJson,requireFinishedImport} from './cohort-snapshot.mjs';
import {generateStrategyDescription} from '../packages/domain/dist/index.js';

const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
assert(args.includes('--output')&&args.includes('--import-report')&&args.includes('--import-pid'),'--output --import-report --import-pid required');
const output=resolve(value('--output')),importReport=resolve(value('--import-report')),pid=Number(value('--import-pid'));
assert(Number.isInteger(pid)&&pid>1);await mkdir(output,{recursive:true});
const state=async(stage,extra={})=>{const r={stage,at:new Date().toISOString(),...extra};await saveJson(resolve(output,'state.json'),r);console.log(JSON.stringify(r));};
async function child(script,parameters,name,production=false){
 const log=await open(resolve(output,name+'.log'),'a');
 try{const env={...process.env};if(!production)delete env.DATABASE_URL;
  const p=spawn(process.execPath,['--max-old-space-size=6144',script,...parameters],{env,stdio:['ignore',log.fd,log.fd]});
  await state(name,{pid:p.pid});await new Promise((ok,no)=>{p.on('error',no);p.on('exit',(code,signal)=>code===0?ok():no(Error(`${name} exited ${code}/${signal}; see log`)));});
 }finally{await log.close();}
}
try{
 await state('waiting_for_import');const until=Date.now()+24*3600000;
 for(;;){let complete=false;try{requireFinishedImport(await readFile(importReport,'utf8'));complete=true;}catch(e){if(e.code&&e.code!=='ENOENT')throw e;}
  if(complete)break;
  try{process.kill(pid,0);}catch{throw Error('Importer stopped without a summary; inspect/repair import before restarting pipeline');}
  assert(Date.now()<until,'Import wait exceeded 24 hours; no snapshot taken');await new Promise(r=>setTimeout(r,15000));
 }
 const snapshotDir=resolve(output,'snapshot');let existing;
 try{existing=JSON.parse(await readFile(resolve(snapshotDir,'manifest.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!existing){await state('exporting_snapshot');await snapshot({connectionString:process.env.DATABASE_URL,output:snapshotDir,importReport});}
 // Sequential workers bound memory on the 16 GiB Mac; each child has no production URL.
 for(const chain of ['bsc','robin','sol'])await child('scripts/cohort-research.mjs',[snapshotDir,resolve(output,chain),chain,'256'],`research-${chain}`);
 await state('local_research_complete');
 const lines=['# 三链信号日期分组研究','', '历史 CA 分组稳健性，不是严格时间外验证，不保证未来收益。数据和参数冻结；D4/D5 未用于本轮调参。',''];
 for(const chain of ['sol','robin','bsc']){
  const r=JSON.parse(await readFile(resolve(output,chain,'report.json'),'utf8'));
  lines.push(`## ${chain.toUpperCase()}`,'',`候选 ${r.candidates}；开发期通过 ${r.shortlist.ids.length}；稳定且成本压力通过 ${r.uploadCandidates.length}。`,r.conclusion,'','| 分段 | 首次信号日期（北京时间） | CA 数 |','| --- | --- | ---: |');
  for(const f of r.partition.folds)lines.push(`| D${f.id} | ${f.from} 至 ${f.toExclusive}（不含） | ${r.partition.entries.filter(e=>e.fold===f.id).length} |`);
  lines.push('','| 策略 | D1收益% | D2收益% | D3收益% | D4收益% | D5收益% | 判定 |','| --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for(const s of r.results){lines.push(`| ${s.id} | ${[...s.development,...s.validation].map(f=>f.accountReturn.toFixed(2)).join(' | ')} | ${s.pass?(s.costSensitive?'历史达标／成本敏感':'历史达标／成本压力通过'):'未达标'} |`);}
  if(!r.results.length)lines.push('| — | — | — | — | — | — | 无候选通过开发期门槛 |');
  for(const id of r.uploadCandidates){const c=r.results.find(c=>c.id===id);lines.push('',`### ${id}`,'',generateStrategyDescription(c.config).generatedText,'');}
  lines.push('','详细分段交易数、回撤、费用、末根平仓贡献、覆盖缺失及探索榜见同链 report.json；没有交易样本的分段不算验证通过。','');
 }
 await writeFile(resolve(output,'report.md'),lines.join('\n'));
 if(args.includes('--submit')){
  assert(args.includes('--api'),'--api required with --submit');
  for(const chain of ['bsc','robin','sol']){
   await child('scripts/cohort-server-verify.mjs',[snapshotDir,resolve(output,chain),resolve(output,chain,'server'),value('--api'),'--submit'],`server-${chain}`,true);
   try{const verified=JSON.parse(await readFile(resolve(output,chain,'server','server-verified.json'),'utf8'));lines.push('',`## ${chain.toUpperCase()} 服务器逐笔复验`,'');
    for(const r of verified)lines.push(`- ${r.name}：[任务记录](${value('--api').replace(/\/$/,'')}/backtests/${r.id})；净收益 ${r.report.returnPercent.toFixed(2)}%，逐笔交易和信号一致。`);
    await writeFile(resolve(output,'report.md'),lines.join('\n'));
   }catch(e){if(e.code!=='ENOENT')throw e;}
  }
 }
 await state('completed',{report:resolve(output,'report.md')});
}catch(e){await state('failed',{error:String(e)});process.exitCode=1;}
