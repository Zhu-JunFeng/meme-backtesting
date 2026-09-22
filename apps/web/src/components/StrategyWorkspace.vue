<script setup lang="ts">
import { generateStrategyDescription } from "@meme/domain";
import StrategyDescription from "./StrategyDescription.vue";
import { computed, onMounted, ref, watch } from "vue";
import { message, Modal } from "ant-design-vue";
import { InboxOutlined, BranchesOutlined, CopyOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons-vue";
import { api } from "../api";
import ConditionGroupEditor from "./ConditionGroupEditor.vue";
import SchemaFields from "./SchemaFields.vue";

const definitions = ref<any[]>([]);
const templates = ref<any[]>([]);
const versions = ref<any[]>([]);
const selectedTemplateId = ref<string>();
const selectedVersionId = ref<string>();
const strategy = ref<any>();
const notes=ref("");
const savedDescription=ref<any>();
let versionEpoch=0,templateEpoch=0;
const fullDescription=computed(()=>{try{return strategy.value ? generateStrategyDescription(strategy.value,notes.value) : null;}catch{return null;}});
const template = ref<any>();
const loading = ref(false);
const saving = ref(false);
const createOpen = ref(false);
const cloneOpen = ref(false);
const dialog = ref({ name: "", description: "" });
const definitionMap = computed(() => new Map(definitions.value.map(item => [item.code, item])));

async function refreshTemplates(preferred?: string) {
  templates.value = (await api.get("/strategy-templates")).data;
  selectedTemplateId.value = preferred || selectedTemplateId.value || templates.value.find(item => item.status === "active")?.id || templates.value[0]?.id;
}
async function loadTemplate() {
  if (!selectedTemplateId.value) return;
  const request=++templateEpoch; ++versionEpoch; strategy.value=undefined; notes.value=""; savedDescription.value=null;
  loading.value = true;
  try {
    const [detail, history] = await Promise.all([api.get(`/strategy-templates/${selectedTemplateId.value}`), api.get(`/strategy-templates/${selectedTemplateId.value}/versions`)]);
    if(request!==templateEpoch)return;
    template.value = detail.data;
    versions.value = history.data;
    selectedVersionId.value = detail.data.currentVersionId || versions.value[0]?.id;
    await loadVersion();
  } finally { if(request===templateEpoch)loading.value = false; }
}
async function loadVersion() {
  const request=++versionEpoch; strategy.value=undefined; notes.value=""; savedDescription.value=null;
  if (!selectedVersionId.value) return;
  const {data}=await api.get(`/strategy-versions/${selectedVersionId.value}`);
  if(request!==versionEpoch)return;
  strategy.value=structuredClone(data.strategyJson);
  strategy.value.entryAfterSignal ??= true;
  savedDescription.value=data.versionDescription ?? null;
  notes.value=data.versionDescription?.notes ?? "";
}
async function saveVersion() {
  if (!strategy.value || !selectedTemplateId.value) return;
  saving.value = true;
  try {
    const version = (await api.post(`/strategy-templates/${selectedTemplateId.value}/versions`, { strategyJson: strategy.value, notes:notes.value })).data;
    message.success(`已保存为不可变版本 v${version.version}`);
    await refreshTemplates(selectedTemplateId.value);
    await loadTemplate();
  } catch (error:any) { message.error(error.response?.data?.message || "策略保存失败"); }
  finally { saving.value = false; }
}
function openCreate() { dialog.value = { name: "新策略模板", description: "" }; createOpen.value = true; }
async function createTemplate() {
  if (!dialog.value.name.trim() || !strategy.value) return message.warning("请输入模板名称");
  const created = (await api.post("/strategy-templates", { ...dialog.value, status: "draft", strategyJson: strategy.value, notes:notes.value })).data;
  createOpen.value = false;
  await refreshTemplates(created.id);
  await loadTemplate();
  message.success("已创建独立模板和 v1 版本");
}
function openClone() { dialog.value = { name: `${template.value.name} 副本`, description: template.value.description }; cloneOpen.value = true; }
async function cloneTemplate() {
  if (!selectedVersionId.value || !dialog.value.name.trim()) return;
  const created = (await api.post(`/strategy-versions/${selectedVersionId.value}/clone`, dialog.value)).data;
  cloneOpen.value = false;
  await refreshTemplates(created.id);
  await loadTemplate();
  message.success("策略已复制为独立模板");
}
function archiveTemplate() {
  if (!template.value) return;
  Modal.confirm({ title: "归档这个策略模板？", content: "历史版本和回测结果仍会保留。", okText: "归档", cancelText: "取消", async onOk() { await api.patch(`/strategy-templates/${template.value.id}`, { status: "archived" }); await refreshTemplates(); await loadTemplate(); } });
}
async function restoreTemplate() {
  try {
    await api.patch(`/strategy-templates/${template.value.id}`, { status: "active" });
    await refreshTemplates(); await loadTemplate();
    message.success("策略已恢复启用，版本和历史结果未改变");
  } catch (error:any) { message.error(error.response?.data?.message || "恢复失败，请重试"); }
}
function setPositionMode(mode: string) { strategy.value.positionConfig.mode = mode; if (mode === "single_entry") strategy.value.positionConfig.maxEntries = 1; }
function setStopType(type: string) { strategy.value.exitConfig.stopLoss = type === "percent" ? { type, value: 10 } : type === "fib_level" ? { type, ratio: .886, bufferPercent: 0 } : { type, bufferPercent: 0 }; }
function setTargetType(type: string) { strategy.value.exitConfig.takeProfit = type === "percent" ? { type, value: 20 } : type === "risk_reward" ? { type, ratio: 2 } : type === "fib_target" ? { type, ratio: .382 } : { type }; }
function toggleLock(enabled:boolean) { strategy.value.exitConfig.profitLock={enabled,tiers:strategy.value.exitConfig.profitLock?.tiers ?? [{activationPercent:50,floorPercent:20},{activationPercent:100,floorPercent:60}]}; }

function groupSummary(group:any): string {
  if (!group) return "未配置";
  const active = group.conditions.filter((item:any) => item.enabled !== false);
  const labels = active.map((item:any) => item.conditions ? `(${groupSummary(item)})` : definitionMap.value.get(item.type)?.name || item.type);
  if (!labels.length) return "未启用";
  if (group.mode === "at_least") return `${labels.join("、")}（至少 ${group.minMatches || 1} 项）`;
  return labels.join(group.mode === "all" ? " 且 " : " 或 ");
}
const summary = computed(() => strategy.value ? [
  strategy.value.entryAfterSignal!==false?'仅在首次外部信号后买入；信号前行情用于指标预热；缺失信号的 CA 排除':'不限制信号前买入（可能高估实际可参与的交易机会）',
  `识别涨幅 ≥ ${strategy.value.impulseCondition.minGainPercent}%、最长 ${strategy.value.impulseCondition.maxDurationBars} 根的 Fractal 拉升`,
  `入场：${groupSummary(strategy.value.entryConditionGroup)}`,
  `失效：${groupSummary(strategy.value.invalidationConditionGroup)}`,
  strategy.value.exitConfig.profitLock?.enabled ? `动态锁盈（收盘确认，下一根生效）：${strategy.value.exitConfig.profitLock.tiers.map((t:any)=>`盈利 ${t.activationPercent}% → 保底 ${t.floorPercent}%`).join('；')}；加仓后锁盈价不下调` : '动态锁盈：关闭',
  `${strategy.value.positionConfig.mode === "pyramiding" ? `最多 ${strategy.value.positionConfig.maxEntries} 次买入` : "持仓期间只允许单次买入"}，每次使用 ${strategy.value.positionConfig.sizing.value}${strategy.value.positionConfig.sizing.type === "fixed_amount" ? " 固定金额" : "% 资金"}`,
  `成本：手续费 ${strategy.value.executionConfig.feePercent}% + 滑点 ${strategy.value.executionConfig.slippagePercent}%`
] : []);

watch(selectedTemplateId, loadTemplate);
watch(selectedVersionId, loadVersion);
onMounted(async () => { definitions.value = (await api.get("/condition-definitions")).data; await refreshTemplates(); await loadTemplate(); });
</script>

<template>
  <div class="workspace-grid">
    <aside class="template-panel">
      <div class="panel-heading"><div><span class="eyebrow">策略库</span><h2>策略模板</h2></div><a-button type="text" @click="openCreate"><PlusOutlined /></a-button></div>
      <div class="template-list">
        <button v-for="item in templates" :key="item.id" class="template-row" :class="{ active:item.id===selectedTemplateId }" @click="selectedTemplateId=item.id">
          <span class="template-name">{{ item.name }}</span>
          <span class="template-meta"><a-tag :color="item.status==='active'?'green':item.status==='archived'?'default':'gold'">{{ item.status }}</a-tag><span>v{{ item.currentVersion || '—' }}</span></span>
        </button>
      </div>
    </aside>

    <a-spin :spinning="loading" class="editor-panel">
      <template v-if="template && strategy">
        <header class="editor-header">
          <div><div class="eyebrow">当前模板 · v{{ versions.find(item => item.id===selectedVersionId)?.version }}</div><h1>{{ template.name }}</h1><p>{{ template.description }}</p></div>
          <a-space wrap>
            <a-select v-model:value="selectedVersionId" style="width:130px" :options="versions.map(item => ({value:item.id,label:`历史 v${item.version}`}))" />
            <a-button @click="openClone"><CopyOutlined />复制</a-button>
            <a-button v-if="template.status==='archived'" @click="restoreTemplate">恢复启用</a-button>
            <a-button v-else @click="archiveTemplate"><InboxOutlined />归档</a-button>
            <a-button type="primary" :loading="saving" @click="saveVersion"><SaveOutlined />保存新版本</a-button>
          </a-space>
        </header>

        <a-alert message="版本不可覆盖" description="你正在编辑一个工作副本。保存时会生成新的不可变版本，已有回测继续引用原版本。" type="info" show-icon />

        <section class="summary-panel"><div class="section-title"><BranchesOutlined /><div><h3>规则摘要</h3><p>保存前核对策略的实际含义</p></div></div><ol><li v-for="line in summary" :key="line">{{ line }}</li></ol></section>

        <StrategyDescription :key="selectedVersionId" :description="savedDescription" :version="versions.find(item=>item.id===selectedVersionId)?.version" />
        <StrategyDescription :description="fullDescription" preview />
        <a-form-item label="新版本补充备注（可选）"><a-textarea v-model:value="notes" :rows="4" :maxlength="20000" show-count placeholder="补充适用场景、验证结论或注意事项；修改备注也将保存为新版本。" /></a-form-item>
        <section class="config-section"><div class="section-copy"><h3>入场时间限制</h3><p>保存到策略版本。创建回测时读取项目最早外部信号，信号前历史仍用于指标预热。</p></div><a-form-item label="仅在信号触发后买入"><a-switch v-model:checked="strategy.entryAfterSignal" /><p>开启时，买入及加仓 K 线开盘必须严格晚于信号时间。缺失信号的 CA 会排除并提示。</p></a-form-item></section>
        <a-tabs class="strategy-tabs">
          <a-tab-pane key="impulse" tab="拉升识别">
            <section class="config-section"><div class="section-copy"><h3>Fractal Pivot</h3><p>{{ definitionMap.get('impulse_fractal_swing')?.description }}</p></div><SchemaFields v-model="strategy.impulseCondition" :schema="definitionMap.get('impulse_fractal_swing')?.parameterSchema" /></section>
          </a-tab-pane>
          <a-tab-pane key="entry" tab="入场条件"><section class="config-section"><div class="section-copy"><h3>入场条件组</h3><p>仅已启用条件参与组合判断；可以嵌套条件组。</p></div><ConditionGroupEditor v-model="strategy.entryConditionGroup" :definitions="definitions" category="entry" root /></section></a-tab-pane>
          <a-tab-pane key="invalidation" tab="信号失效"><section class="config-section"><div class="section-copy"><h3>失效条件组</h3><p>硬止损优先，其次判断失效条件，再判断止盈。</p></div><ConditionGroupEditor v-model="strategy.invalidationConditionGroup" :definitions="definitions" category="invalidation" root /></section></a-tab-pane>
          <a-tab-pane key="risk" tab="止盈止损">
            <section class="config-section form-grid">
              <div class="section-copy full"><h3>退出与风控</h3><p>首期只执行一次性止盈；到期退出按收盘值成交。</p></div>
              <a-form-item label="止损方式"><a-select :value="strategy.exitConfig.stopLoss.type" @change="(value:any) => setStopType(value)"><a-select-option value="percent">入场价固定比例</a-select-option><a-select-option value="fib_level">Fib 位下方</a-select-option><a-select-option value="swing_low">Swing Low 下方</a-select-option></a-select></a-form-item>
              <a-form-item v-if="strategy.exitConfig.stopLoss.type==='percent'" label="止损比例 (%)"><a-input-number v-model:value="strategy.exitConfig.stopLoss.value" :min="0.1" :max="100" style="width:100%" /></a-form-item>
              <a-form-item v-else-if="strategy.exitConfig.stopLoss.type==='fib_level'" label="Fib 位"><a-select v-model:value="strategy.exitConfig.stopLoss.ratio" :options="[.382,.5,.618,.65,.786,.886].map(value=>({value,label:value}))" /></a-form-item>
              <a-form-item v-else label="前低缓冲 (%)"><a-input-number v-model:value="strategy.exitConfig.stopLoss.bufferPercent" :min="0" :max="20" style="width:100%" /></a-form-item>
              <a-form-item label="止盈方式"><a-select :value="strategy.exitConfig.takeProfit.type" @change="(value:any) => setTargetType(value)"><a-select-option value="percent">固定比例</a-select-option><a-select-option value="risk_reward">固定盈亏比</a-select-option><a-select-option value="fib_target">Fib 目标</a-select-option><a-select-option value="previous_high">前高</a-select-option></a-select></a-form-item>
              <a-form-item v-if="strategy.exitConfig.takeProfit.type==='percent'" label="止盈比例 (%)"><a-input-number v-model:value="strategy.exitConfig.takeProfit.value" :min="0.1" style="width:100%" /></a-form-item>
              <a-form-item v-else-if="strategy.exitConfig.takeProfit.type==='risk_reward'" label="盈亏比"><a-input-number v-model:value="strategy.exitConfig.takeProfit.ratio" :min="0.1" :step=".1" style="width:100%" /></a-form-item>
              <a-form-item v-else-if="strategy.exitConfig.takeProfit.type==='fib_target'" label="目标 Fib 位"><a-select v-model:value="strategy.exitConfig.takeProfit.ratio" :options="[.382,.5,.618,.65].map(value=>({value,label:value}))" /></a-form-item>
              <a-form-item label="最大持仓 K 线"><a-input-number v-model:value="strategy.exitConfig.maxHoldingBars" :min="1" style="width:100%" /></a-form-item>
              <a-form-item label="结束时平仓"><a-switch v-model:checked="strategy.exitConfig.closeAtEnd" /></a-form-item>
              <div class="full add-group">
                <h4>多档动态锁盈</h4>
                <a-switch :checked="strategy.exitConfig.profitLock?.enabled ?? false" @change="(v:any)=>toggleLock(v)" checked-children="启用" un-checked-children="关闭" aria-label="启用动态锁盈" />
                <template v-if="strategy.exitConfig.profitLock?.enabled">
                  <p>按加权成本计算毛盈利；收盘达到门槛，下一根启用。锁盈价只能上移，滑点、手续费和跳空可能使实际利润低于保底比例。</p>
                  <div v-for="(tier,i) in strategy.exitConfig.profitLock.tiers" :key="i" class="lock-tier">
                    <a-form-item :label="`档位 ${Number(i)+1}：激活盈利 (%)`"><a-input-number v-model:value="tier.activationPercent" :min="0.01" /></a-form-item>
                    <a-form-item label="保底盈利 (%)"><a-input-number v-model:value="tier.floorPercent" :min="0" /></a-form-item>
                    <a-button danger @click="strategy.exitConfig.profitLock.tiers.splice(i,1)">删除档位</a-button>
                  </div>
                  <a-button @click="strategy.exitConfig.profitLock.tiers.push({activationPercent:(strategy.exitConfig.profitLock.tiers.at(-1)?.activationPercent ?? 0)+50,floorPercent:(strategy.exitConfig.profitLock.tiers.at(-1)?.floorPercent ?? 0)+20})">添加档位</a-button>
                  <a-alert type="warning" show-icon message="原有固定止盈仍然有效，可能在锁盈档位激活前先卖出。档位激活比例和保底比例须逐档递增，保底比例必须低于激活比例。" />
                </template>
              </div>
            </section>
          </a-tab-pane>
          <a-tab-pane key="position" tab="仓位与加仓">
            <section class="config-section form-grid">
              <div class="section-copy full"><h3>仓位模型</h3><p>加仓采用加权平均成本；当前策略最多同时持有指定数量的项目。</p></div>
              <a-form-item label="买入模式"><a-select :value="strategy.positionConfig.mode" @change="(value:any) => setPositionMode(value)"><a-select-option value="single_entry">单次买入</a-select-option><a-select-option value="pyramiding">允许加仓</a-select-option></a-select></a-form-item>
              <a-form-item label="最大买入次数"><a-input-number v-model:value="strategy.positionConfig.maxEntries" :min="1" :disabled="strategy.positionConfig.mode==='single_entry'" style="width:100%" /></a-form-item>
              <a-form-item label="最大同时持仓"><a-input-number v-model:value="strategy.positionConfig.maxConcurrentPositions" :min="1" style="width:100%" /></a-form-item>
              <a-form-item label="平仓后再入场"><a-switch v-model:checked="strategy.positionConfig.allowReentry" /></a-form-item>
              <a-form-item label="仓位方式"><a-select v-model:value="strategy.positionConfig.sizing.type"><a-select-option value="fixed_percent">资金比例</a-select-option><a-select-option value="fixed_amount">固定金额</a-select-option><a-select-option value="risk_percent">固定风险比例</a-select-option></a-select></a-form-item>
              <a-form-item label="单次仓位"><a-input-number v-model:value="strategy.positionConfig.sizing.value" :min=".1" style="width:100%" /></a-form-item>
              <div v-if="strategy.positionConfig.mode==='pyramiding'" class="full add-group"><h4>加仓条件</h4><p>默认复用首次入场条件；启用后可单独定义。</p><a-switch v-model:checked="strategy.addConditionGroup.enabled" checked-children="独立条件" un-checked-children="复用入场" /><ConditionGroupEditor v-if="strategy.addConditionGroup.enabled" v-model="strategy.addConditionGroup" :definitions="definitions" category="entry" root /></div>
            </section>
          </a-tab-pane>
          <a-tab-pane key="cost" tab="成本模型">
            <section class="config-section form-grid"><div class="section-copy full"><h3>默认执行成本</h3><p>创建任务时可覆盖这些值，覆盖后的完整配置会写入任务快照。</p></div><a-form-item label="初始资金"><a-input-number v-model:value="strategy.executionConfig.initialCapital" :min="1" style="width:100%" /></a-form-item><a-form-item label="手续费 (%)"><a-input-number v-model:value="strategy.executionConfig.feePercent" :min="0" :step=".1" style="width:100%" /></a-form-item><a-form-item label="滑点 (%)"><a-input-number v-model:value="strategy.executionConfig.slippagePercent" :min="0" :step=".1" style="width:100%" /></a-form-item><a-form-item label="买入税 (%)"><a-input-number v-model:value="strategy.executionConfig.buyTaxPercent" :min="0" :step=".1" style="width:100%" /></a-form-item><a-form-item label="卖出税 (%)"><a-input-number v-model:value="strategy.executionConfig.sellTaxPercent" :min="0" :step=".1" style="width:100%" /></a-form-item><a-form-item label="成交时点"><a-select v-model:value="strategy.executionConfig.fillMode"><a-select-option value="current_bar_close">当前 K 线收盘</a-select-option><a-select-option value="next_bar_open" disabled>下一根开盘（预留）</a-select-option></a-select></a-form-item></section>
          </a-tab-pane>
        </a-tabs>
      </template>
      <a-empty v-else description="请选择一个策略模板" />
    </a-spin>

    <a-modal v-model:open="createOpen" title="新建策略模板" ok-text="创建" cancel-text="取消" @ok="createTemplate"><a-form layout="vertical"><a-form-item label="名称" required><a-input v-model:value="dialog.name" /></a-form-item><a-form-item label="说明"><a-textarea v-model:value="dialog.description" :rows="3" /></a-form-item></a-form><a-alert message="将以当前编辑中的策略规则作为 v1。" type="info" /></a-modal>
    <a-modal v-model:open="cloneOpen" title="复制策略模板" ok-text="复制" cancel-text="取消" @ok="cloneTemplate"><a-form layout="vertical"><a-form-item label="新模板名称" required><a-input v-model:value="dialog.name" /></a-form-item><a-form-item label="说明"><a-textarea v-model:value="dialog.description" :rows="3" /></a-form-item></a-form></a-modal>
  </div>
</template>

<style scoped>
.lock-tier{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.add-group > :deep(.ant-switch){align-self:flex-start;min-width:64px}
.workspace-grid{display:grid;grid-template-columns:240px minmax(0,1fr);gap:18px;align-items:start}.template-panel,.editor-panel{background:#fff;border:1px solid #dfe6e3;border-radius:10px}.template-panel{position:sticky;top:20px;overflow:hidden}.panel-heading{display:flex;align-items:center;justify-content:space-between;padding:18px 16px 12px}.panel-heading h2,.editor-header h1{margin:2px 0 0;color:#18211f}.panel-heading h2{font-size:17px}.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#6a7773;font-weight:700}.template-list{padding:0 8px 10px;display:flex;flex-direction:column;gap:3px}.template-row{border:0;background:transparent;text-align:left;border-radius:7px;padding:11px 10px;cursor:pointer;color:#26312e}.template-row:hover{background:#f4f7f6}.template-row.active{background:#eaf3f0;color:#125548}.template-name{display:block;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.template-meta{display:flex;justify-content:space-between;align-items:center;margin-top:7px;font-size:12px;color:#74817d}.editor-panel{padding:22px;min-height:620px}.editor-header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:18px}.editor-header h1{font-size:22px}.editor-header p{margin:7px 0 0;color:#66736f;max-width:70ch}.summary-panel,.config-section{margin-top:18px;border:1px solid #dfe6e3;border-radius:9px;padding:18px;background:#fff}.summary-panel{background:#f8faf9}.section-title{display:flex;gap:11px;align-items:flex-start}.section-title h3,.section-copy h3{margin:0;color:#18211f;font-size:16px}.section-title p,.section-copy p,.add-group p{margin:4px 0 0;color:#66736f;font-size:13px}.summary-panel ol{margin:14px 0 0;padding-left:21px;color:#35423e}.summary-panel li+li{margin-top:6px}.strategy-tabs{margin-top:12px}.config-section{margin-top:0;display:flex;flex-direction:column;gap:18px}.section-copy{padding-bottom:14px;border-bottom:1px solid #edf1ef}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px}.full{grid-column:1/-1}.add-group{display:flex;flex-direction:column;gap:12px;border-top:1px solid #edf1ef;padding-top:18px}.add-group h4{margin:0}.form-grid :deep(.ant-form-item){margin-bottom:15px}@media(max-width:980px){.workspace-grid{grid-template-columns:1fr}.template-panel{position:static}.template-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.editor-header{flex-direction:column}}@media(max-width:680px){.template-list,.form-grid{grid-template-columns:1fr}.editor-panel{padding:15px}}
</style>
