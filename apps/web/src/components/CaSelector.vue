<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import { api } from "../api";
import { caKey, type CaSelection } from "../composables/useCaSelection";
const props=defineProps<{selection:CaSelection}>();
const s=props.selection.state;
const chains=ref<string[]>([]),chainError=ref("");
const selectedKeys=computed(()=>s.selected.map(caKey));
const poolCount=computed(()=>s.selected.reduce((sum,r)=>sum+r.poolCount,0));
async function loadChains(){
 try{chains.value=(await api.get("/market/chains")).data;chainError.value="";}
 catch{chainError.value="链列表加载失败";}
}
function date(t:any){return t ? new Date(Number(t)).toLocaleString():"—";}
onMounted(loadChains);
</script>
<template>
 <a-form-item label="批量选择链">
  <a-select v-model:value="s.chains" mode="multiple" placeholder="选择链自动全选；留空可手动选择 CA" aria-label="批量选择链" :options="chains.map(value=>({value,label:value.toUpperCase()}))" style="width:100%" />
  <p class="help">选择链后自动选中全部符合条件的 CA，可手动排除。修改周期、类型或时间范围会更新名单，并保留排除项。</p>
 </a-form-item>
 <a-alert v-if="chainError" :message="chainError" type="warning" show-icon><template #action><a-button @click="loadChains">重试链列表</a-button></template></a-alert>
 <a-alert v-if="s.listError || s.bulkError" :message="s.bulkError || s.listError" description="名单尚未完整更新，暂不可提交回测。请重试或调整条件。" type="error" show-icon><template #action><a-button @click="selection.retry">重试</a-button></template></a-alert>
 <div class="filters">
  <a-input-search v-model:value="s.search" placeholder="输入完整 CA，仅搜索展示列表" aria-label="完整 CA 搜索" @search="selection.search" />
  <a-select v-model:value="s.sort" aria-label="CA 排序" :options="[{value:'ca',label:'按 CA 排序'},{value:'minTime',label:'最早数据优先'},{value:'maxTime',label:'最新数据优先'}]" />
 </div>
 <div class="selection" aria-live="polite">
  <span>已选 {{ s.selected.length }} 个 CA / {{ poolCount }} 个池 · 排除 {{ s.excluded.length }} 个 CA</span>
  <span v-if="s.chains.length" class="chain-summary">所选链：{{s.chains.map(c=>c.toUpperCase()).join('、')}}</span>
  <span v-if="s.bulkLoading">正在获取完整名单，暂不可提交…</span>
  <a-button :loading="s.bulkLoading" :disabled="selection.blocked.value || !s.total" @click="selection.selectAll">全选展示结果（{{ s.total }}）</a-button>
  <a-button :disabled="!s.selected.length && !s.chains.length && !s.excluded.length && !s.bulkLoading" @click="selection.clear">清空选择</a-button>
 </div>
 <a-table :data-source="s.rows" :row-key="caKey" size="small" :loading="s.listLoading" :scroll="{x:680}" :row-selection="{selectedRowKeys:selectedKeys,preserveSelectedRowKeys:true,onChange:selection.change,getCheckboxProps:()=>({disabled:selection.blocked.value})}" :pagination="{current:s.page,pageSize:20,total:s.total,showSizeChanger:false,onChange:selection.setPage}" :columns="[{title:'链',dataIndex:'chain',width:65},{title:'合约地址',dataIndex:'ca'},{title:'有效池 / 全部池',key:'pools',width:120},{title:'有效 K 线覆盖范围',key:'range',width:185}]">
  <template #bodyCell="{column,record}"><template v-if="column.key==='pools'">{{record.availablePoolCount}} / {{record.poolCount}}</template><template v-if="column.key==='range'"><small>{{date(record.minTime)}}<br/>{{date(record.maxTime)}}</small></template><code v-if="column.dataIndex==='ca'">{{record.ca}}</code></template>
  <template #expandedRowRender="{record}"><div v-for="pair in record.pairIds" :key="pair"><code>{{pair}}</code></div></template>
  <template #emptyText>当前条件下没有有效 K 线，请调整链、周期、类型或时间范围。</template>
 </a-table>
 <p class="help">表头复选框仅操作当前页。搜索、排序和翻页不改变按链选择范围；选择 CA 会纳入其全部交易池。</p>
</template>
<style scoped>.filters,.selection{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}.filters>.ant-input-search{flex:1;min-width:230px}.selection>span:first-child{margin-right:auto;font-weight:600}.chain-summary,.help{color:#53635e;font-size:12px}.help{margin:8px 0}code{overflow-wrap:anywhere;font-size:12px}</style>
