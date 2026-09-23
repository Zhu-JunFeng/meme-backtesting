/** Human-readable companion to the frozen, machine-readable cross-set study. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const read=async path=>JSON.parse(await readFile(path,'utf8'));
const number=value=>Number.isFinite(value)?value.toFixed(2):'—';
const cell=r=>r?`${number(r.accountReturn)}% / ${r.totalTrades} / ${number(r.accountMaxDrawdown)}%`:'—';
const reason=x=>[
 ...x.assessment.smallPass.flatMap((pass,i)=>pass?[]:[`小集合 ${i+1}`]),
 ...[['剩余',x.assessment.reservePass],['独立大集合',x.assessment.largePass],['全量',x.assessment.fullPass]].flatMap(([label,pass])=>pass?[]:[label]),
 ...(x.stressLarge&&!x.assessment.stressPass?['加滑点']:[]),
 ...(x.withoutBest&&!x.assessment.withoutBestPass?['去最大盈利 CA']:[]),
 ...((x.assessment.maxRelativeDeviation??Infinity)>.5?['小集合收益差异超过 50%']:[]),
].join('、')||'全部门槛通过';
export async function summarizeStudy(root){
 root=resolve(root);
 const lines=['# 三链信号后入场策略研究结果','','本批历史跨集合研究；旧研究曾接触部分相同数据，不是未来收益保证。仅以任务快照及逐根行情回放计算，收益包含末根平仓。','',
  '表格单元格格式：净账户收益率 / 平仓交易数 / 最大回撤；百分数单位均为 %。筛选门槛：所有集合正收益、至少 10 笔、回撤不超过 10%，六个小集合相对中位收益最大偏差不超过 50%；压力测试还要求独立大集合正收益。',''];
 for(const chain of ['sol','robin','bsc']){
  const dir=resolve(root,chain),report=await read(resolve(dir,'report.json')),training=await read(resolve(dir,'training.json')),protocol=await read(resolve(dir,'protocol.json'));
  const devPass=training.filter(x=>x.pass).length;
  lines.push(`## ${chain.toUpperCase()}`,'',
   `信号 CA ${report.coverage.signalCAs}，两周期均具备信号后有效行情的 CA ${report.coverage.eligibleCAs}，未纳入 ${report.coverage.excluded.length}；六个小集合各 ${report.partition.size} 个 CA，剩余集合 ${report.partition.reserve} 个 CA。候选 ${report.candidates}，开发期通过 ${devPass}，冻结验证 ${report.shortlist.length}，全部门槛通过 ${report.passed.length}。`,
   `固定成本：手续费 ${protocol.costs.feePercent}%，单边滑点 ${protocol.costs.slippagePercent}%，买税 ${protocol.costs.buyTaxPercent}%，卖税 ${protocol.costs.sellTaxPercent}%。`,'');
  if(!report.results.length){
   lines.push('没有候选通过开发期三个小集合的预设门槛；验证组未用于补调参数。','');
  }else{
   lines.push('| 候选 | D1 | D2 | D3 | V1 | V2 | V3 | 剩余 | 独立大集合 | 全量 | 结果 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
   for(const x of report.results)lines.push(`| ${x.id} | ${[...x.development,...x.validation,x.reserve,x.large,x.full].map(cell).join(' | ')} | ${x.pass?'达标':reason(x)} |`);
   lines.push('','基础集合门槛未通过者不再运行压力测试；下表的“—”表示未执行，不表示压力测试亏损。','',
    '| 候选 | 独立大集合 +1pp 单边滑点 | 去最大盈利 CA 后独立大集合 |',
    '| --- | --- | --- |');
   for(const x of report.results)lines.push(`| ${x.id} | ${cell(x.stressLarge)} | ${cell(x.withoutBest)} |`);
   lines.push('');
   for(const x of report.results)lines.push(`### ${x.id}：${x.pass?'本批历史跨集合达标':'仅探索，未达标'}`,'',x.rules||'规则说明不可用','');
  }
  const leaders=[...training].sort((a,b)=>(b.development?.[0]?.accountReturn??-Infinity)-(a.development?.[0]?.accountReturn??-Infinity)).slice(0,5);
  lines.push('D1 探索收益前五（仅作探索，不代表验证通过）：','');
  for(const x of leaders)lines.push(`- ${x.id}：${cell(x.development[0])}；开发期 ${x.pass?'通过':'未通过'}`);
  lines.push('');
 }
 const output=resolve(root,'summary.md');await writeFile(output,lines.join('\n'));return output;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)console.log(await summarizeStudy(process.argv[2]));
