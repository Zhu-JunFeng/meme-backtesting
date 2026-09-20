<script setup lang="ts">
defineProps<{fib:any;isMcap:boolean}>();
const utc=(t:number)=>new Date(t).toISOString().replace('T',' ').replace('.000Z',' UTC');
const raw=(n:number)=>Number(n).toString();
</script>
<template>
 <details v-if="fib" class="fib-audit">
  <summary>Fib 核验明细 · {{fib.status==='available'?fib.source:'依据不完整'}}</summary>
  <a-alert v-if="fib.status!=='available'" :message="fib.reason" type="warning" show-icon />
  <template v-if="fib.impulse">
   <p>值 = High − (High − Low) × 比例；0 = Swing High，1 = Swing Low。以下{{isMcap?'市值':'价格'}}未缩写，显示舍入不参与计算。</p>
   <dl><dt>Swing Low</dt><dd>{{raw(fib.impulse.low)}} · 索引 {{fib.impulse.lowIndex}} · {{fib.low?utc(fib.low.time):'时间不可用'}} {{fib.low?.synthetic?'（补齐 K 线）':''}}</dd>
    <dt>Swing High</dt><dd>{{raw(fib.impulse.high)}} · 索引 {{fib.impulse.highIndex}} · {{fib.high?utc(fib.high.time):'时间不可用'}} {{fib.high?.synthetic?'（补齐 K 线）':''}}</dd>
    <dt>高点确认</dt><dd>索引 {{fib.impulse.confirmedAtIndex}} · {{fib.confirmed?utc(fib.confirmed.time):'时间不可用'}} {{fib.confirmed?.synthetic?'（补齐 K 线）':''}}</dd>
    <dt>拉升</dt><dd>{{((fib.impulse.high/fib.impulse.low-1)*100).toFixed(2)}}% · {{fib.impulse.highIndex-fib.impulse.lowIndex}} 根</dd></dl>
   <div class="fib-tables"><table><caption>Fib 档位与配置用途（不等同于独立触发原因）</caption><thead><tr><th>比例</th><th>{{isMcap?'市值':'价格'}}</th><th>配置关系</th></tr></thead><tbody><tr v-for="line in fib.levels" :key="line.ratio"><td>{{line.ratio}}</td><td>{{raw(line.value)}}</td><td>{{line.uses.join('；') || '标准参考位'}}</td></tr><tr v-for="line in fib.thresholds" :key="line.label"><td>实际阈值</td><td>{{raw(line.value)}}</td><td>{{line.label}}</td></tr></tbody></table>
   <table><caption>原始买入与加仓</caption><thead><tr><th>事件 / 时间</th><th>原始成交值</th><th>实际回撤比例</th></tr></thead><tbody><tr v-for="(buy,index) in fib.buys" :key="index"><td>{{buy.label}} · {{utc(buy.time)}}</td><td>{{raw(buy.value)}}</td><td>{{buy.ratio.toFixed(6)}}（{{(buy.ratio*100).toFixed(2)}}%）</td></tr></tbody></table></div>
   <details><summary>入场条件组原始配置（all 全部 / any 任一 / at_least 至少 N 项）</summary><pre>{{JSON.stringify(fib.conditionGroup,null,2)}}</pre></details>
  </template>
 </details>
</template>
<style scoped>
.fib-audit{margin-top:12px;padding:12px;border:1px solid #dfe6e3;border-radius:8px;color:#31483f}summary{cursor:pointer;font-weight:600}p{line-height:1.6}dl{display:grid;grid-template-columns:100px 1fr;gap:8px}dd{margin:0;overflow-wrap:anywhere}.fib-tables{overflow-x:auto}table{border-collapse:collapse;width:100%;margin:12px 0;font-variant-numeric:tabular-nums}caption{text-align:left;font-weight:600;color:#31483f}th,td{text-align:left;padding:8px;border-bottom:1px solid #dfe6e3;min-width:90px}pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
