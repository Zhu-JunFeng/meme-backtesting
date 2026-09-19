<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { message } from "ant-design-vue";
import { ClockCircleOutlined, DatabaseOutlined, PlayCircleOutlined } from "@ant-design/icons-vue";
import { api } from "../api";
import TradingViewChart from "./TradingViewChart.vue";

const templates = ref<any[]>([]);
const versions = ref<any[]>([]);
const projects = ref<any[]>([]);
const runs = ref<any[]>([]);
const selectedTemplateId = ref<string>();
const selectedVersionId = ref<string>();
const selectedProjectKeys = ref<string[]>([]);
const selectedVersion = ref<any>();
const activeRun = ref<any>();
const report = ref<any>();
const loading = ref(false);
const detailsLoading = ref(false);
let timer: number | undefined;
const form = ref({ name: "Fib 黄金口袋回测", interval: "30s", valueType: "mcap", startTime: "", endTime: "", initialCapital: undefined as number|undefined, feePercent: undefined as number|undefined, slippagePercent: undefined as number|undefined, buyTaxPercent: undefined as number|undefined, sellTaxPercent: undefined as number|undefined });
const projectOptions = computed(() => projects.value.map(project => ({ value: keyOf(project), label: `${project.chain} · ${short(project.ca)} · ${short(project.pairId)}` })));
const selectedProjects = computed(() => selectedProjectKeys.value.map(key => projects.value.find(project => keyOf(project) === key)).filter(Boolean));
const chartProject = ref<any>();
const chartSymbol = computed(() => chartProject.value ? `${chartProject.value.chain}:${chartProject.value.ca}:${chartProject.value.pairId}:${activeRun.value?.config_json?.valueType || form.value.valueType}` : "");
const strategySummary = computed(() => {
  const value = selectedVersion.value?.strategyJson;
  if (!value) return [];
  return [`Fractal 拉升 ≥ ${value.impulseCondition.minGainPercent}% / 最长 ${value.impulseCondition.maxDurationBars} 根`, `入场条件 ${countActive(value.entryConditionGroup)} 项，失效条件 ${countActive(value.invalidationConditionGroup)} 项`, `${value.positionConfig.mode === "single_entry" ? "单次买入" : `最多 ${value.positionConfig.maxEntries} 次买入`} · 仓位 ${value.positionConfig.sizing.value}${value.positionConfig.sizing.type === "fixed_amount" ? "" : "%"}`, `默认手续费 ${value.executionConfig.feePercent}% · 滑点 ${value.executionConfig.slippagePercent}%`];
});

function keyOf(project:any) { return `${project.chain}|${project.ca}|${project.pairId}`; }
function short(value:string) { return value?.length > 14 ? `${value.slice(0,6)}…${value.slice(-5)}` : value; }
function countActive(group:any): number { return group?.conditions?.filter((item:any) => item.enabled !== false).reduce((sum:number,item:any) => sum + (item.conditions ? countActive(item) : 1), 0) || 0; }
function localDate(value:number) { const date = new Date(value); const offset = date.getTimezoneOffset() * 60000; return new Date(value - offset).toISOString().slice(0,16); }
function statusColor(status:string) { return status === "completed" ? "green" : status === "failed" ? "red" : status === "running" ? "blue" : status === "cancelled" ? "default" : "gold"; }
function statusText(status:string) { return ({pending:"等待中",running:"运行中",completed:"已完成",failed:"失败",cancelled:"已取消"} as any)[status] || status; }
function fmt(value:any, digits=2) { const number = Number(value); return Number.isFinite(number) ? number.toLocaleString("zh-CN", { maximumFractionDigits: digits }) : "—"; }

async function refreshRuns() { runs.value = (await api.get("/backtests")).data; }
async function loadVersions() {
  if (!selectedTemplateId.value) return;
  const selectedTemplate = templates.value.find(item => item.id === selectedTemplateId.value);
  versions.value = (await api.get(`/strategy-templates/${selectedTemplateId.value}/versions`)).data;
  selectedVersionId.value = selectedTemplate?.currentVersionId || versions.value[0]?.id;
}
async function loadVersion() { selectedVersion.value = selectedVersionId.value ? (await api.get(`/strategy-versions/${selectedVersionId.value}`)).data : undefined; }
function onProjectsChanged() {
  if (!selectedProjects.value.length) return;
  const earliest = Math.max(...selectedProjects.value.map(project => Number(project.minTime || Date.now() - 7 * 86400000)));
  const latest = Math.min(...selectedProjects.value.map(project => Number(project.maxTime || Date.now())));
  if (earliest < latest) { form.value.startTime = localDate(earliest); form.value.endTime = localDate(latest); }
}
async function create() {
  if (!selectedVersionId.value) return message.warning("请选择策略版本");
  if (!selectedProjects.value.length) return message.warning("至少选择一个链 / CA / 交易池");
  if (!form.value.startTime || !form.value.endTime) return message.warning("请选择回测时间范围");
  loading.value = true;
  try {
    const overrides = Object.fromEntries(Object.entries({ initialCapital: form.value.initialCapital, feePercent: form.value.feePercent, slippagePercent: form.value.slippagePercent, buyTaxPercent: form.value.buyTaxPercent, sellTaxPercent: form.value.sellTaxPercent }).filter(([,value]) => value !== undefined && value !== null));
    await api.post("/backtests", { name: form.value.name, strategyVersionId: selectedVersionId.value, dataset: { symbols: selectedProjects.value.map(({chain,ca,pairId}) => ({chain,ca,pairId})), interval: form.value.interval, valueType: form.value.valueType, startTime: new Date(form.value.startTime).toISOString(), endTime: new Date(form.value.endTime).toISOString() }, executionOverrides: overrides });
    message.success("回测任务已提交到后台");
    await refreshRuns();
  } catch (error:any) { message.error(error.response?.data?.message || "任务创建失败"); }
  finally { loading.value = false; }
}
async function openRun(run:any) {
  detailsLoading.value = true;
  try {
    activeRun.value = (await api.get(`/backtests/${run.id}`)).data;
    report.value = (await api.get(`/backtests/${run.id}/report`)).data;
    const symbol = activeRun.value.config_json?.symbols?.[0];
    chartProject.value = symbol || undefined;
  } finally { detailsLoading.value = false; }
}

watch(selectedTemplateId, loadVersions);
watch(selectedVersionId, loadVersion);
watch(selectedProjectKeys, onProjectsChanged, { deep: true });
onMounted(async () => {
  const [templateResponse, projectResponse] = await Promise.all([api.get("/strategy-templates"), api.get("/market/projects")]);
  templates.value = templateResponse.data.filter((item:any) => item.status !== "archived");
  projects.value = projectResponse.data;
  selectedTemplateId.value = templates.value.find((item:any) => item.status === "active")?.id || templates.value[0]?.id;
  await refreshRuns();
  timer = window.setInterval(refreshRuns, 5000);
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="backtest-layout">
    <section class="launch-panel">
      <header class="panel-header"><div><span class="eyebrow">新任务</span><h2>创建 K 线回测</h2><p>策略规则与运行数据集分开保存，任务会保留完整快照。</p></div><PlayCircleOutlined class="header-icon" /></header>
      <div class="step-block"><div class="step-label"><span>1</span><div><strong>选择策略版本</strong><small>运行后不会跟随模板更新</small></div></div><div class="two-columns"><a-form-item label="策略模板"><a-select v-model:value="selectedTemplateId" :options="templates.map(item=>({value:item.id,label:item.name}))" /></a-form-item><a-form-item label="不可变版本"><a-select v-model:value="selectedVersionId" :options="versions.map(item=>({value:item.id,label:`v${item.version} · ${new Date(item.createdAt).toLocaleString()}`}))" /></a-form-item></div><div v-if="strategySummary.length" class="readonly-summary"><span v-for="item in strategySummary" :key="item">{{ item }}</span></div></div>
      <div class="step-block"><div class="step-label"><span>2</span><div><strong>选择 K 线数据集</strong><small>第一版仅支持单周期 OHLCV</small></div></div><a-form-item label="链 / CA / 交易池"><a-select v-model:value="selectedProjectKeys" mode="multiple" show-search :filter-option="(input:string,option:any)=>option.label.toLowerCase().includes(input.toLowerCase())" :options="projectOptions" placeholder="可选择多个项目" /></a-form-item><div class="three-columns"><a-form-item label="K 线类型"><a-segmented v-model:value="form.valueType" :options="[{label:'市值',value:'mcap'},{label:'价格',value:'price'}]" /></a-form-item><a-form-item label="周期"><a-select v-model:value="form.interval"><a-select-option v-for="value in ['30s','1m','5m','15m','1h','4h','1d']" :key="value" :value="value">{{ value }}</a-select-option></a-select></a-form-item><a-form-item label="已选项目"><div class="selection-count"><DatabaseOutlined />{{ selectedProjects.length }} 个</div></a-form-item></div><div class="two-columns"><a-form-item label="开始时间"><a-input v-model:value="form.startTime" type="datetime-local" /></a-form-item><a-form-item label="结束时间"><a-input v-model:value="form.endTime" type="datetime-local" /></a-form-item></div></div>
      <div class="step-block"><div class="step-label"><span>3</span><div><strong>运行覆盖项</strong><small>留空则使用策略版本默认值</small></div></div><div class="override-grid"><a-form-item label="初始资金"><a-input-number v-model:value="form.initialCapital" :placeholder="String(selectedVersion?.strategyJson.executionConfig.initialCapital || '')" :min="1" /></a-form-item><a-form-item label="手续费 %"><a-input-number v-model:value="form.feePercent" :placeholder="String(selectedVersion?.strategyJson.executionConfig.feePercent || 0)" :min="0" /></a-form-item><a-form-item label="滑点 %"><a-input-number v-model:value="form.slippagePercent" :placeholder="String(selectedVersion?.strategyJson.executionConfig.slippagePercent || 0)" :min="0" /></a-form-item><a-form-item label="买入税 %"><a-input-number v-model:value="form.buyTaxPercent" :placeholder="String(selectedVersion?.strategyJson.executionConfig.buyTaxPercent || 0)" :min="0" /></a-form-item><a-form-item label="卖出税 %"><a-input-number v-model:value="form.sellTaxPercent" :placeholder="String(selectedVersion?.strategyJson.executionConfig.sellTaxPercent || 0)" :min="0" /></a-form-item></div></div>
      <footer class="launch-footer"><a-input v-model:value="form.name" placeholder="任务名称" /><a-button type="primary" size="large" :loading="loading" @click="create"><PlayCircleOutlined />执行回测</a-button></footer>
    </section>

    <section class="history-panel"><div class="history-heading"><div><span class="eyebrow">运行记录</span><h2>历史任务</h2></div><ClockCircleOutlined /></div><div v-if="runs.length" class="run-list"><button v-for="run in runs" :key="run.id" class="run-row" :class="{active:activeRun?.id===run.id}" @click="openRun(run)"><div><strong>{{ run.name }}</strong><small>{{ run.strategyName ? `${run.strategyName} · v${run.strategyVersion}` : '旧版配置快照' }}</small></div><div class="run-status"><a-tag :color="statusColor(run.status)">{{ statusText(run.status) }}</a-tag><span v-if="['pending','running'].includes(run.status)">{{ Math.round(Number(run.progress)*100) }}%</span></div></button></div><a-empty v-else description="还没有回测任务" /></section>

    <a-spin :spinning="detailsLoading" class="result-panel">
      <template v-if="activeRun">
        <header class="result-header"><div><span class="eyebrow">任务结果</span><h2>{{ activeRun.name }}</h2></div><a-tag :color="statusColor(activeRun.status)">{{ statusText(activeRun.status) }}</a-tag></header>
        <div v-if="report" class="metric-grid"><div><small>净收益</small><strong :class="Number(report.netPnl)>=0?'positive':'negative'">{{ fmt(report.netPnl) }}</strong></div><div><small>收益率</small><strong>{{ fmt(report.returnPercent) }}%</strong></div><div><small>胜率</small><strong>{{ fmt(report.winRate*100) }}%</strong></div><div><small>最大回撤</small><strong>{{ fmt(report.maxDrawdownPercent) }}%</strong></div><div><small>交易次数</small><strong>{{ report.totalTrades }}</strong></div><div><small>Profit Factor</small><strong>{{ fmt(report.profitFactor) }}</strong></div></div>
        <a-alert v-else :message="activeRun.status==='failed' ? activeRun.error_message : '任务尚未生成报告'" :type="activeRun.status==='failed'?'error':'info'" show-icon />
        <div class="chart-toolbar"><h3>K 线与买卖点位</h3><a-select v-if="activeRun.config_json?.symbols?.length>1" v-model:value="chartProject" :options="activeRun.config_json.symbols.map((item:any)=>({value:item,label:`${item.chain} · ${short(item.ca)}`}))" /></div>
        <TradingViewChart v-if="chartSymbol" :symbol="chartSymbol" :interval="activeRun.config_json?.interval || '30s'" :run-id="activeRun.id" />
        <a-collapse class="snapshot"><a-collapse-panel key="snapshot" header="查看本次任务的实际配置快照"><pre>{{ JSON.stringify(activeRun.config_json, null, 2) }}</pre></a-collapse-panel></a-collapse>
      </template>
      <a-empty v-else description="从历史任务中选择一项查看报告与点位" />
    </a-spin>
  </div>
</template>

<style scoped>
.backtest-layout{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(290px,.7fr);gap:18px;align-items:start}.launch-panel,.history-panel,.result-panel{background:#fff;border:1px solid #dfe6e3;border-radius:10px}.launch-panel{padding:22px}.panel-header,.history-heading,.result-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.panel-header h2,.history-heading h2,.result-header h2{font-size:19px;margin:2px 0;color:#18211f}.panel-header p{margin:6px 0 0;color:#66736f}.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6a7773;font-weight:700}.header-icon{font-size:27px;color:#176b5b}.step-block{padding:20px 0;border-top:1px solid #edf1ef}.panel-header+.step-block{margin-top:18px}.step-label{display:flex;gap:11px;align-items:center;margin-bottom:15px}.step-label>span{width:25px;height:25px;border-radius:50%;background:#e8f2ef;color:#176b5b;display:grid;place-items:center;font-weight:700}.step-label strong,.step-label small{display:block}.step-label small{color:#7a8783;margin-top:2px}.two-columns,.three-columns,.override-grid{display:grid;gap:0 14px}.two-columns{grid-template-columns:repeat(2,minmax(0,1fr))}.three-columns{grid-template-columns:1fr 1fr .7fr}.override-grid{grid-template-columns:repeat(5,minmax(90px,1fr))}.override-grid :deep(.ant-input-number){width:100%}.readonly-summary{display:flex;flex-wrap:wrap;gap:7px;background:#f6f9f8;border-radius:7px;padding:10px}.readonly-summary span{font-size:12px;border-right:1px solid #d7e0dd;padding-right:8px;color:#4d5a56}.readonly-summary span:last-child{border:0}.selection-count{height:32px;display:flex;align-items:center;gap:7px;color:#176b5b;font-weight:650}.launch-footer{display:flex;gap:12px;justify-content:flex-end;padding-top:4px}.launch-footer .ant-input{max-width:300px}.history-panel{overflow:hidden}.history-heading{padding:19px 17px 13px}.history-heading>span{color:#87928f}.run-list{padding:0 8px 9px;max-height:660px;overflow:auto}.run-row{width:100%;border:0;border-top:1px solid #edf1ef;background:#fff;text-align:left;padding:13px 9px;cursor:pointer;display:flex;justify-content:space-between;gap:10px;border-radius:6px}.run-row:hover,.run-row.active{background:#f2f7f5}.run-row strong,.run-row small{display:block}.run-row strong{color:#26312e}.run-row small{color:#7a8783;margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px}.run-status{text-align:right;font-size:11px;color:#7a8783}.run-status span{display:block;margin-top:4px}.result-panel{grid-column:1/-1;padding:22px;min-height:360px}.metric-grid{display:grid;grid-template-columns:repeat(6,minmax(110px,1fr));border:1px solid #e2e9e6;border-radius:8px;overflow:hidden;margin:18px 0}.metric-grid>div{padding:14px;border-right:1px solid #e2e9e6;background:#f9fbfa}.metric-grid>div:last-child{border:0}.metric-grid small,.metric-grid strong{display:block}.metric-grid small{color:#75817e;margin-bottom:6px}.metric-grid strong{font-size:18px;font-variant-numeric:tabular-nums;color:#26312e}.metric-grid .positive{color:#237356}.metric-grid .negative{color:#b33d38}.chart-toolbar{display:flex;align-items:center;justify-content:space-between;margin:22px 0 10px}.chart-toolbar h3{margin:0}.snapshot{margin-top:14px}.snapshot pre{max-height:420px;overflow:auto;background:#101713;color:#d6e3de;padding:14px;border-radius:6px;font-size:12px}.backtest-layout :deep(.ant-form-item){margin-bottom:13px}@media(max-width:1050px){.backtest-layout{grid-template-columns:1fr}.metric-grid{grid-template-columns:repeat(3,1fr)}.override-grid{grid-template-columns:repeat(3,1fr)}}@media(max-width:680px){.two-columns,.three-columns,.override-grid,.metric-grid{grid-template-columns:1fr}.launch-footer{flex-direction:column}.launch-footer .ant-input{max-width:none}}
</style>
