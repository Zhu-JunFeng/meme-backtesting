<script setup lang="ts">
import { computed } from 'vue';
import { exitLabel, invalidationEvidence } from '../format';
const props=defineProps<{record:any}>();
const detail=computed(()=>props.record.invalidation_detail ?? props.record.reason_json?.invalidation);
const invalid=computed(()=>(props.record.signal_type ?? props.record.exit_reason)==='invalidation');
</script>
<template>
 <span v-if="!invalid">{{exitLabel(record)}}</span>
 <span v-else class="exit-reason">
  <span>{{exitLabel(record)}}</span>
  <a-popover trigger="click" title="失效退出依据">
   <template #content><div class="evidence"><p v-for="(line,i) in invalidationEvidence(detail)" :key="i">{{line}}</p><p>来源：{{detail?.source==='signal_snapshot'?'退出信号快照':detail?.source==='frozen_input'?'冻结行情只读还原':'历史记录不完整'}}</p><p v-if="detail?.matches?.length>1">多个条件同时满足；统计按配置顺序首个命中原因计一笔，其余原因在此保留。</p><p>这是退出触发原因，不代表交易一定亏损。</p></div></template>
   <a-button type="link" size="small" aria-label="查看失效退出依据">查看依据</a-button>
  </a-popover>
 </span>
</template>
<style scoped>
.exit-reason{display:inline-flex;align-items:baseline;flex-wrap:wrap;gap:4px;min-width:140px}.evidence{max-width:min(420px,75vw);overflow-wrap:anywhere}.evidence p{margin:0 0 8px}.evidence p:last-child{margin-bottom:0;color:#53635e}
</style>
