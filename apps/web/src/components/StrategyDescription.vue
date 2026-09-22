<script setup lang="ts">
import { computed } from 'vue';
import type { RunStrategyDescription, VersionDescription, ExecutionConfig } from '@meme/domain';
import { formatNumber } from '../format';
const props=defineProps<{description?:VersionDescription | RunStrategyDescription | null; version?:number; execution?:ExecutionConfig; preview?:boolean}>();
const labels:Record<string,string>={initialCapital:'初始资金',feePercent:'手续费 (%)',slippagePercent:'滑点 (%)',buyTaxPercent:'买入税 (%)',sellTaxPercent:'卖出税 (%)'};
const overrides=computed(()=>props.description && 'executionOverrides' in props.description ? Object.entries(props.description.executionOverrides) : []);
</script>
<template>
  <details class="strategy-description">
    <summary>{{preview?'新版本完整流程预览':'策略说明'}}<span v-if="version"> · v{{version}}</span><span class="hint">{{description?' · 点击展开':' · 暂无版本描述'}}</span></summary>
    <template v-if="description">
      <p class="help">{{preview?'随参数实时生成；保存后不可覆盖。':'此处为保存时的版本说明，不跟随模板更新。'}} 生成器 v{{description.generatorVersion}}</p>
      <div class="prose">{{description.generatedText}}</div>
      <template v-if="description.notes"><h4>补充备注</h4><div class="prose">{{description.notes}}</div></template>
      <template v-if="execution">
        <h4>本次任务执行值</h4><p class="help">以下为实际配置快照；覆盖项优先于上述版本默认值。</p>
        <dl><template v-for="(label,key) in labels" :key="key"><dt>{{label}}</dt><dd>{{formatNumber(execution[key as keyof ExecutionConfig])}}</dd></template></dl>
        <p v-if="overrides.length" class="help">创建时覆盖：{{overrides.map(([key,value])=>`${labels[key] || key} = ${formatNumber(value)}`).join('；')}}</p>
        <p v-else class="help">未提交执行覆盖项。</p>
      </template>
    </template>
    <p v-else class="help">暂无版本描述。旧版本和历史任务不补生成；保存新版本后可查看完整流程。</p>
  </details>
</template>
<style scoped>
.strategy-description{margin:14px 0;padding:12px 14px;border:1px solid #dfe6e3;border-radius:8px;background:#fafcfb;color:#263b33}
summary{cursor:pointer;font-weight:600;overflow-wrap:anywhere}summary:focus-visible{outline:2px solid #176b5b;outline-offset:4px}.hint,.help{font-weight:400;color:#53665d;font-size:13px}details[open] .hint{display:none}.help{margin:12px 0}.prose{white-space:pre-wrap;overflow-wrap:anywhere;max-width:72ch;line-height:1.8;font-size:14px}h4{margin:20px 0 8px}dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);max-width:480px;gap:8px}dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}@media(max-width:680px){.strategy-description{padding:12px}.prose{line-height:1.75}}
</style>
