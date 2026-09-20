<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { ClockCircleOutlined, DatabaseOutlined, PlayCircleOutlined } from "@ant-design/icons-vue";
import { api } from "../api";
import { useCaSelection } from "../composables/useCaSelection";
import CaSelector from "./CaSelector.vue";
import RunDetail from "./RunDetail.vue";
import RunActions from "./RunActions.vue";

const templates = ref<any[]>([]);
const versions = ref<any[]>([]);

const runs = ref<any[]>([]);
const selectedTemplateId = ref<string>();
const selectedVersionId = ref<string>();

const selectedVersion = ref<any>();
const activeRun = ref<any>();
const mobileView = ref('history');
const loading = ref(false);
let timer: number | undefined;
const form = ref({ name: "Fib 黄金口袋回测", interval: "30s", valueType: "mcap", startTime: "", endTime: "", initialCapital: undefined as number|undefined, feePercent: undefined as number|undefined, slippagePercent: undefined as number|undefined, buyTaxPercent: undefined as number|undefined, sellTaxPercent: undefined as number|undefined });
const caSelection=useCaSelection(()=>form.value,async params=>(await api.get("/market/cas",{params})).data);
const selectedCas=computed(()=>caSelection.state.selected);
const selectionBlocked=caSelection.blocked;
const strategySummary = computed(() => {
  const value = selectedVersion.value?.strategyJson;
  if (!value) return [];
  return [`Fractal 拉升 ≥ ${value.impulseCondition.minGainPercent}% / 最长 ${value.impulseCondition.maxDurationBars} 根`, `入场条件 ${countActive(value.entryConditionGroup)} 项，失效条件 ${countActive(value.invalidationConditionGroup)} 项`, `${value.positionConfig.mode === "single_entry" ? "单次买入" : `最多 ${value.positionConfig.maxEntries} 次买入`} · 仓位 ${value.positionConfig.sizing.value}${value.positionConfig.sizing.type === "fixed_amount" ? "" : "%"}`, `默认手续费 ${value.executionConfig.feePercent}% · 滑点 ${value.executionConfig.slippagePercent}%`,value.exitConfig.profitLock?.enabled?`动态锁盈：${value.exitConfig.profitLock.tiers.map((t:any)=>`${t.activationPercent}% → 保底 ${t.floorPercent}%`).join('；')}（收盘确认，下一根生效）`:'动态锁盈：关闭'];
});

function countActive(group:any): number { return group?.conditions?.filter((item:any) => item.enabled !== false).reduce((sum:number,item:any) => sum + (item.conditions ? countActive(item) : 1), 0) || 0; }
function statusColor(status:string) { return status === "completed" ? "green" : status === "failed" ? "red" : status === "running" ? "blue" : status === "cancelled" ? "default" : "gold"; }
function statusText(status:string) { return ({pending:"等待中",running:"运行中",completed:"已完成",failed:"失败",stopped:"已停止",stopping:"停止中",cancelled:"已取消"} as any)[status] || status; }

async function refreshRuns() { try { runs.value = (await api.get("/backtests")).data; } catch { message.error("任务列表加载失败，请稍后刷新"); } }
async function loadVersions() {
  if (!selectedTemplateId.value) return;
  const selectedTemplate = templates.value.find(item => item.id === selectedTemplateId.value);
  versions.value = (await api.get(`/strategy-templates/${selectedTemplateId.value}/versions`)).data;
  selectedVersionId.value = selectedTemplate?.currentVersionId || versions.value[0]?.id;
}
async function loadVersion() { selectedVersion.value = selectedVersionId.value ? (await api.get(`/strategy-versions/${selectedVersionId.value}`)).data : undefined; }

async function create() {
  if (selectionBlocked.value) return message.warning("请等待名单更新完成，或重试失败的查询");
  if (!selectedVersionId.value) return message.warning("请选择策略版本");
  if (!selectedCas.value.length) return message.warning("至少选择一个 CA");

  loading.value = true;
  try {
    const overrides = Object.fromEntries(Object.entries({ initialCapital: form.value.initialCapital, feePercent: form.value.feePercent, slippagePercent: form.value.slippagePercent, buyTaxPercent: form.value.buyTaxPercent, sellTaxPercent: form.value.sellTaxPercent }).filter(([,value]) => value !== undefined && value !== null));
    const dataset = {cas:selectedCas.value.map(({chain,ca})=>({chain,ca})),interval:form.value.interval,valueType:form.value.valueType,startTime:form.value.startTime ? new Date(form.value.startTime).toISOString():undefined,endTime:form.value.endTime ? new Date(form.value.endTime).toISOString():undefined,filters:caSelection.snapshot()};
    const preview=(await api.post("/market/dataset-preview",dataset)).data;
    const confirmed=await new Promise<boolean>(resolve=>Modal.confirm({title:"确认回测数据集",content:`共 ${preview.caCount} 个 CA、${preview.poolCount} 个池；可回测 ${preview.availablePoolCount} 个池，无数据 ${preview.noDataPoolCount} 个池。所有交易池共享一笔初始资金。`,okText:"提交任务",cancelText:"返回检查",onOk:()=>resolve(true),onCancel:()=>resolve(false)}));
    if(!confirmed)return;
    await api.post("/backtests",{name:form.value.name,strategyVersionId:selectedVersionId.value,dataset,executionOverrides:overrides});
    message.success("回测任务已提交到后台");
    await refreshRuns();
  } catch (error:any) { message.error(error.response?.data?.message || "任务创建失败"); }
  finally { loading.value = false; }
}
function openRun(run:any) { activeRun.value=run; }

watch(selectedTemplateId, loadVersions);
watch(selectedVersionId, loadVersion);

onMounted(async () => {
  const templateResponse = await api.get("/strategy-templates");
  templates.value = templateResponse.data.filter((item:any) => item.status !== "archived");

  selectedTemplateId.value = templates.value.find((item:any) => item.status === "active")?.id || templates.value[0]?.id;
  await refreshRuns();
  timer = window.setInterval(refreshRuns, 5000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <RunDetail v-if="activeRun" :run-id="activeRun.id" @back="activeRun=undefined" />
  <div v-else class="backtest-layout" :class="'mobile-view-'+mobileView">
    <div class="mobile-workspace-switch" role="group" aria-label="回测工作台视图">
      <a-button :type="mobileView==='history'?'primary':'default'" :aria-pressed="mobileView==='history'" @click="mobileView='history'">历史任务（{{runs.length}}）</a-button>
      <a-button :type="mobileView==='create'?'primary':'default'" :aria-pressed="mobileView==='create'" @click="mobileView='create'">创建回测</a-button>
    </div>
    <section class="launch-panel">
      <header class="panel-header"><div><span class="eyebrow">新任务</span><h2>创建 K 线回测</h2><p>策略规则与运行数据集分开保存，任务会保留完整快照。</p></div><PlayCircleOutlined class="header-icon" /></header>
      <div class="step-block"><div class="step-label"><span>1</span><div><strong>选择策略版本</strong><small>运行后不会跟随模板更新</small></div></div><div class="two-columns"><a-form-item label="策略模板"><a-select v-model:value="selectedTemplateId" :options="templates.map(item=>({value:item.id,label:item.name}))" /></a-form-item><a-form-item label="不可变版本"><a-select v-model:value="selectedVersionId" :options="versions.map(item=>({value:item.id,label:`v${item.version} · ${new Date(item.createdAt).toLocaleString()}`}))" /></a-form-item></div><div v-if="strategySummary.length" class="readonly-summary"><span v-for="item in strategySummary" :key="item">{{ item }}</span></div></div>
      <div class="step-block"><div class="step-label"><span>2</span><div><strong>选择 K 线数据集</strong><small>第一版仅支持单周期 OHLCV</small></div></div><div class="three-columns"><a-form-item label="K 线类型"><a-segmented v-model:value="form.valueType" :options="[{label:'市值',value:'mcap'},{label:'价格',value:'price'}]" /></a-form-item><a-form-item label="周期"><a-select v-model:value="form.interval"><a-select-option v-for="value in ['30s','1m','5m','15m','1h','4h','1d']" :key="value" :value="value">{{ value }}</a-select-option></a-select></a-form-item><a-form-item label="已选项目"><div class="selection-count"><DatabaseOutlined />{{ selectedCas.length }} 个</div></a-form-item></div><div class="two-columns"><a-form-item label="开始时间（可留空）"><a-input v-model:value="form.startTime" type="datetime-local" /></a-form-item><a-form-item label="结束时间（可留空）"><a-input v-model:value="form.endTime" type="datetime-local" /></a-form-item></div><CaSelector :selection="caSelection" /></div>
      <div class="step-block"><div class="step-label"><span>3</span><div><strong>运行覆盖项</strong><small>留空则使用策略版本默认值</small></div></div><div class="override-grid"><a-form-item label="初始资金"><a-input-number v-model:value="form.initialCapital" :placeholder="String(selectedVersion?.strategyJson.executionConfig.initialCapital || '')" :min="1" /></a-form-item><a-form-item label="手续费 %"><a-input-number v-model:value="form.feePercent" :placeholder="String(selectedVersion?.strategyJson.executionConfig.feePercent || 0)" :min="0" /></a-form-item><a-form-item label="滑点 %"><a-input-number v-model:value="form.slippagePercent" :placeholder="String(selectedVersion?.strategyJson.executionConfig.slippagePercent || 0)" :min="0" /></a-form-item><a-form-item label="买入税 %"><a-input-number v-model:value="form.buyTaxPercent" :placeholder="String(selectedVersion?.strategyJson.executionConfig.buyTaxPercent || 0)" :min="0" /></a-form-item><a-form-item label="卖出税 %"><a-input-number v-model:value="form.sellTaxPercent" :placeholder="String(selectedVersion?.strategyJson.executionConfig.sellTaxPercent || 0)" :min="0" /></a-form-item></div></div>
      <footer class="launch-footer"><a-input v-model:value="form.name" placeholder="任务名称" /><a-button type="primary" size="large" :loading="loading" :disabled="selectionBlocked || !selectedCas.length" @click="create"><PlayCircleOutlined />执行回测</a-button></footer>
    </section>

    <section class="history-panel"><div class="history-heading"><div><span class="eyebrow">运行记录</span><h2>历史任务</h2></div><ClockCircleOutlined /></div><div v-if="runs.length" class="run-list"><div v-for="run in runs" :key="run.id" class="run-row" :class="{active:activeRun?.id===run.id}" role="button" tabindex="0" @keydown.enter.self="openRun(run)" @click="openRun(run)"><div><strong>{{ run.name }}</strong><small>{{ run.strategyName ? `${run.strategyName} · v${run.strategyVersion}` : '旧版配置快照' }}</small></div><div class="run-status"><a-tag :color="statusColor(run.status)">{{ statusText(run.status) }}</a-tag><span v-if="['pending','running'].includes(run.status)">{{ Math.round(Number(run.progress)*100) }}%</span></div><RunActions :run="run" @changed="refreshRuns" /></div></div><a-empty v-else description="还没有回测任务" /></section>


  </div>
</template>

<style scoped>
.backtest-layout{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(290px,.7fr);gap:18px;align-items:start}.launch-panel,.history-panel,.result-panel{background:#fff;border:1px solid #dfe6e3;border-radius:10px}.launch-panel{padding:22px}.panel-header,.history-heading,.result-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.panel-header h2,.history-heading h2,.result-header h2{font-size:19px;margin:2px 0;color:#18211f}.panel-header p{margin:6px 0 0;color:#66736f}.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6a7773;font-weight:700}.header-icon{font-size:27px;color:#176b5b}.step-block{padding:20px 0;border-top:1px solid #edf1ef}.panel-header+.step-block{margin-top:18px}.step-label{display:flex;gap:11px;align-items:center;margin-bottom:15px}.step-label>span{width:25px;height:25px;border-radius:50%;background:#e8f2ef;color:#176b5b;display:grid;place-items:center;font-weight:700}.step-label strong,.step-label small{display:block}.step-label small{color:#7a8783;margin-top:2px}.two-columns,.three-columns,.override-grid{display:grid;gap:0 14px}.two-columns{grid-template-columns:repeat(2,minmax(0,1fr))}.three-columns{grid-template-columns:1fr 1fr .7fr}.override-grid{grid-template-columns:repeat(5,minmax(90px,1fr))}.override-grid :deep(.ant-input-number){width:100%}.readonly-summary{display:flex;flex-wrap:wrap;gap:7px;background:#f6f9f8;border-radius:7px;padding:10px}.readonly-summary span{font-size:12px;border-right:1px solid #d7e0dd;padding-right:8px;color:#4d5a56}.readonly-summary span:last-child{border:0}.selection-count{height:32px;display:flex;align-items:center;gap:7px;color:#176b5b;font-weight:650}.launch-footer{display:flex;gap:12px;justify-content:flex-end;padding-top:4px}.launch-footer .ant-input{max-width:300px}.history-panel{overflow:hidden}.history-heading{padding:19px 17px 13px}.history-heading>span{color:#87928f}.run-list{padding:0 8px 9px;max-height:660px;overflow:auto}.run-row{width:100%;border:0;border-top:1px solid #edf1ef;background:#fff;text-align:left;padding:13px 9px;cursor:pointer;display:flex;justify-content:space-between;gap:10px;border-radius:6px}.run-row:hover,.run-row.active{background:#f2f7f5}.run-row strong,.run-row small{display:block}.run-row strong{color:#26312e}.run-row small{color:#7a8783;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px}.run-status{text-align:right;font-size:11px;color:#7a8783}.run-status span{display:block;margin-top:4px}.result-panel{grid-column:1/-1;padding:22px;min-height:360px}.metric-grid{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr));border:1px solid #e2e9e6;border-radius:8px;overflow:hidden;margin:18px 0}.metric-grid>div{padding:14px;border-right:1px solid #e2e9e6;background:#f9fbfa}.metric-grid>div:last-child{border:0}.metric-grid small,.metric-grid strong{display:block}.metric-grid small{color:#75817e;margin-bottom:6px}.metric-grid strong{font-size:18px;font-variant-numeric:tabular-nums;color:#26312e}.metric-grid .positive{color:#237356}.metric-grid .negative{color:#b33d38}.chart-toolbar{display:flex;align-items:center;justify-content:space-between;margin:22px 0 10px}.chart-toolbar h3{margin:0}.snapshot{margin-top:14px}.snapshot pre{max-height:420px;overflow:auto;background:#101713;color:#d6e3de;padding:14px;border-radius:6px;font-size:12px}.backtest-layout :deep(.ant-form-item){margin-bottom:13px}@media(max-width:1050px){.backtest-layout{grid-template-columns:1fr}.metric-grid{grid-template-columns:repeat(3,1fr)}.override-grid{grid-template-columns:repeat(3,1fr)}}@media(max-width:680px){.two-columns,.three-columns,.override-grid,.metric-grid{grid-template-columns:1fr}.launch-footer{flex-direction:column}.launch-footer .ant-input{max-width:none}}
</style>
