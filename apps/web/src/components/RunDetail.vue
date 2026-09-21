<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "../api";
import TradingViewChart from "./TradingViewChart.vue";
import RunActions from './RunActions.vue';
import { eventLabels as labels, duration, formatNumber as fmt, preciseValue } from '../format';
import ResultValue from './ResultValue.vue';
import ExitReason from './ExitReason.vue';
import { invalidationLabels } from '../format';
const props=defineProps<{runId:string}>();defineEmits(["back"]);
const run=ref<any>(),report=ref<any>(),summary=ref<any>(),rows=ref<any[]>([]),equity=ref<any[]>([]);
const includeEnd=ref(false),analytics=ref<any>(),refreshing=ref(false);
const selectedSignals=ref<string[]>([]),lowerBusy=ref(false),hiddenUnassociated=ref(0);
const filterParams=computed(()=>({includeEndOfBacktest:includeEnd.value,signalTypes:selectedSignals.value.join(',')}));
const filterableSignals=new Set(Object.keys(labels).filter(type=>type!=='risk_event'));
let filterEpoch=0,preferredTrade:string|undefined;
function toggleSignal(type:string){if(lowerBusy.value||refreshing.value||!filterableSignals.has(type))return;selectedSignals.value=selectedSignals.value.includes(type)?selectedSignals.value.filter(s=>s!==type):[...selectedSignals.value,type];}
const valueLabel=computed(()=>run.value?.config_json.valueType==='mcap'?'市值':'价格');
const loading=ref(false),error=ref(""),search=ref(""),sort=ref("pnl_desc"),page=ref(1),total=ref(0);
const ca=ref<any>(),pairId=ref<string>(),events=ref<any[]>([]),trades=ref<any[]>([]);
const eventPage=ref(1),tradePage=ref(1),eventTotal=ref(0),tradeTotal=ref(0),chart=ref<any>();
const anchor=ref<any>(),locating=ref(false);
let epoch=0,caEpoch=0,poolEpoch=0,locateEpoch=0,loadEpoch=0,timer:number|undefined;
const pool=computed(()=>ca.value?.pools?.find((p:any)=>p.pairId===pairId.value));
const symbol=computed(()=>pool.value ? [pool.value.chain,pool.value.ca,pool.value.pairId,run.value.config_json.valueType].join(":"):"");
const detailValue=(key:string,n:any)=>key==='quantity'||run.value?.config_json.valueType==='price'&&['entry_price','first_entry_price','exit_price','price'].includes(key)?preciseValue(n):fmt(n);
const date=(n:any)=>n===null || n===undefined?"不可用":new Date(Number(n)).toLocaleString();
const equityPoints=computed(()=>{
 if(!equity.value.length)return "";
 const values=equity.value.map(p=>Number(p.equity)),min=Math.min(...values),max=Math.max(...values),span=max-min || 1;
 const start=Number(equity.value[0].time),duration=Number(equity.value.at(-1).time)-start || 1;
 return equity.value.map(p=>`${10+(Number(p.time)-start)/duration*980},${150-(Number(p.equity)-min)/span*130}`).join(" ");
});
async function loadCas() {
 const request=++epoch;
 try {const {data}=await api.get(`/backtests/${props.runId}/cas`,{params:{ca:search.value,sort:sort.value,page:page.value,pageSize:20,...filterParams.value}});if(request!==epoch)return;rows.value=data.items;total.value=data.total;return data;}
 catch(e:any){if(request===epoch)error.value=e.response?.data?.message || "CA 列表加载失败";}
}
async function load() {
 const request=++loadEpoch;loading.value=!run.value;refreshing.value=true;error.value="";
 try {
 const [a,b,c]=await Promise.all([api.get(`/backtests/${props.runId}`),api.get(`/backtests/${props.runId}/statistics`,{params:{includeEndOfBacktest:includeEnd.value}}),api.get(`/backtests/${props.runId}/cas`,{params:{page:1,pageSize:1,includeEndOfBacktest:includeEnd.value}})]);
 if(request!==loadEpoch)return;run.value=a.data;analytics.value=b.data;report.value=b.data.summary;equity.value=b.data.curve;summary.value=c.data.summary;await refreshLower();
 }catch(e:any){if(request===loadEpoch){error.value=e.response?.data?.message || "详情加载失败";lowerBusy.value=false;}}finally{if(request===loadEpoch){loading.value=false;refreshing.value=false;}}
}
async function openCa(row:any,preserve=false) {
 const request=++caEpoch;
 if(!preserve){ca.value=undefined;pairId.value=undefined;events.value=[];trades.value=[];poolEpoch++;}
 try {
 const {data}=await api.get(`/backtests/${props.runId}/ca`,{params:{chain:row.chain,ca:row.ca,...filterParams.value}});
 if(request!==caEpoch)return;ca.value=data;
 if(!preserve)pairId.value=data?.pools?.find((p:any)=>p.trades>0)?.pairId ?? data?.pools?.find((p:any)=>!p.noData)?.pairId ?? data?.pools?.[0]?.pairId;
 }catch{if(request===caEpoch)error.value="CA 详情加载失败";}
}
async function refreshLower(){
 const request=++filterEpoch,previous=ca.value,previousPair=pairId.value,previousTrade=anchor.value?.tradeId ?? preferredTrade;preferredTrade=undefined;
 lowerBusy.value=true;caEpoch++;poolEpoch++;locateEpoch++;anchor.value=undefined;events.value=[];trades.value=[];rows.value=[];total.value=0;hiddenUnassociated.value=0;eventPage.value=1;tradePage.value=1;
 try{
  const list=await loadCas();if(request!==filterEpoch)return;if(!list){ca.value=undefined;pairId.value=undefined;return;}
  let detail:any;
  if(previous){const {data}=await api.get(`/backtests/${props.runId}/ca`,{params:{chain:previous.chain,ca:previous.ca,...filterParams.value}});detail=data;}
  if(request!==filterEpoch)return;
  if(!detail && (previous||selectedSignals.value.length) && rows.value.length){const row=rows.value[0];detail=(await api.get(`/backtests/${props.runId}/ca`,{params:{chain:row.chain,ca:row.ca,...filterParams.value}})).data;}
  if(request!==filterEpoch)return;ca.value=detail;
  pairId.value=detail?.pools?.find((p:any)=>p.pairId===previousPair)?.pairId ?? detail?.pools?.find((p:any)=>p.entries>0)?.pairId ?? detail?.pools?.find((p:any)=>!p.noData)?.pairId;
  await nextTick();if(request!==filterEpoch)return;
  if(pool.value){await Promise.all([loadPool(),locateTrade(pairId.value===previousPair?previousTrade:undefined)]);}
 }catch{if(request===filterEpoch){ca.value=undefined;pairId.value=undefined;error.value='筛选结果加载失败，请重试';}}finally{if(request===filterEpoch)lowerBusy.value=false;}
}
async function loadPool() {
 const request=++poolEpoch;events.value=[];trades.value=[];eventTotal.value=0;tradeTotal.value=0;
 if(!pool.value)return;
 const params={chain:pool.value.chain,ca:pool.value.ca,pairId:pairId.value,pageSize:20,...filterParams.value};
 try {
 const [a,b]=await Promise.all([api.get(`/backtests/${props.runId}/signals`,{params:{...params,page:eventPage.value}}),api.get(`/backtests/${props.runId}/trades`,{params:{...params,page:tradePage.value}})]);
 if(request!==poolEpoch)return;
 events.value=a.data.items;eventTotal.value=a.data.total;trades.value=b.data.items;tradeTotal.value=b.data.total;hiddenUnassociated.value=a.data.hiddenUnassociated ?? 0;
 }catch{if(request===poolEpoch)error.value="交易或事件加载失败";}
}
async function locateTrade(tradeId?:string){
 const epoch=++locateEpoch;anchor.value=undefined;locating.value=true;
 try{const {data}=await api.get(`/backtests/${props.runId}/locate`,{params:{chain:pool.value.chain,ca:pool.value.ca,pairId:pairId.value,tradeId,...filterParams.value}});if(epoch===locateEpoch)anchor.value=data;}
 catch{if(epoch===locateEpoch)error.value='买卖区间定位失败，请重新选择交易池';}finally{if(epoch===locateEpoch)locating.value=false;}
}
watch(symbol,()=>{if(lowerBusy.value)return;locateEpoch++;eventPage.value=1;tradePage.value=1;anchor.value=undefined;if(!pool.value)return;void loadPool();void locateTrade();});
watch([eventPage,tradePage],()=>{if(!lowerBusy.value)void loadPool();});
watch(sort,()=>{page.value=1;loadCas();});
watch(includeEnd,()=>{preferredTrade=anchor.value?.tradeId;filterEpoch++;epoch++;caEpoch++;poolEpoch++;locateEpoch++;anchor.value=undefined;events.value=[];trades.value=[];lowerBusy.value=true;page.value=1;tradePage.value=1;analytics.value=undefined;report.value=undefined;summary.value=undefined;rows.value=[];equity.value=[];void load();});
watch(selectedSignals,()=>{page.value=1;void refreshLower();});
onMounted(()=>{load();timer=window.setInterval(()=>{if(!lowerBusy.value&&!refreshing.value&&["pending","running","stopping"].includes(run.value?.status))load();},5000);});
onBeforeUnmount(()=>{filterEpoch++;loadEpoch++;epoch++;caEpoch++;poolEpoch++;locateEpoch++;window.clearInterval(timer);});
</script>
<template>
 <section class="detail">
  <a-button @click="$emit('back')">← 返回任务列表</a-button>
  <a-alert v-if="error" :message="error" type="error" show-icon style="margin-top:12px"><template #action><a-button @click="load">重试</a-button></template></a-alert>
  <a-skeleton v-if="loading" active />
  <template v-if="run">
   <header><h2>{{run.name}}</h2><a-tag>{{({pending:'等待中',running:'运行中',stopping:'停止中',stopped:'已停止',completed:'已完成',failed:'失败',cancelled:'已取消'} as any)[run.status]}}</a-tag><span>{{report?.engineVersion || run.runtime_version || '历史引擎'}} · {{run.config_json.interval}} · {{run.config_json.valueType==='mcap'?'市值':'价格'}}</span><RunActions :run="run" @changed="load" /></header>
   <p v-if="run.runtime_version" class="help" role="status">阶段：{{({freezing:'冻结输入',computing:'回测计算',saving:'保存结果',completed:'已完成'} as any)[run.phase] || run.phase}} · 恢复 {{run.recovery_count}} 次 · 最近检查点：{{run.checkpoint_at ? new Date(run.checkpoint_at).toLocaleString() : '尚未生成'}}</p>
   <a-alert v-if="run.status!=='completed'" type="info" show-icon message="当前为阶段性结果，最终盈亏报告在任务完成后生成。" />
   <a-progress v-if="['pending','running'].includes(run.status)" :percent="Math.round(Number(run.progress)*100)" />
   <a-alert v-if="run.error_message" :message="run.error_message" type="error" />
   <div class="toolbar stats-filter"><a-space><span>包含结束强平及未平仓交易</span><a-switch v-model:checked="includeEnd" :loading="refreshing" :disabled="refreshing" aria-label="包含结束强平及未平仓交易" /></a-space></div>
   <a-alert v-if="!includeEnd && analytics" type="info" show-icon description="仅统计策略正常退出的完整交易。浮动盈亏当前口径不计入；不是原账户权益，未改变资金占用或后续成交。被排除订单的全部买卖点位和 Fib 同步隐藏。">
    <template #message>已排除：结束强平 {{analytics.excluded.endCount}} 笔 · 已落库未平仓 {{analytics.excluded.openCount}} 笔 · 信息不完整 {{analytics.excluded.incompleteCount}} 笔。可确认的已排除平仓净盈亏 <ResultValue :value="analytics.excluded.netPnl" />（不含未平仓浮盈亏）。</template>
   </a-alert>
   <p v-if="!includeEnd && analytics && !analytics.openCountComplete" class="help" role="status">阶段结果仅含已提交的数据；仍在持仓但尚未落库的订单数量不可用，上述未平仓数量不是完整持仓数。</p>
   <a-descriptions v-if="summary" bordered size="small" :column="{xs:1,sm:2,lg:4}">
    <a-descriptions-item label="CA 总数">{{summary.caCount}}</a-descriptions-item>
    <a-descriptions-item label="有交易 / 无交易 CA">{{summary.tradedCaCount}} / {{summary.untradedCaCount}}</a-descriptions-item>
    <a-descriptions-item label="交易池">{{summary.poolCount}}</a-descriptions-item>
    <a-descriptions-item label="无数据池">{{run.config_json.pools ? summary.noDataPoolCount : '历史任务未记录'}}</a-descriptions-item>
    <a-descriptions-item label="已实现净盈亏"><ResultValue :value="report?.netPnl" /></a-descriptions-item>
    <a-descriptions-item label="浮动净盈亏"><ResultValue :value="report?.unrealizedPnl" /></a-descriptions-item>
    <a-descriptions-item label="整体净盈亏"><ResultValue :value="report?.totalNetPnl ?? report?.netPnl" /></a-descriptions-item>
    <a-descriptions-item label="收益率"><ResultValue :value="report?.returnPercent" percent /></a-descriptions-item>
    <a-descriptions-item label="胜率">{{report?.winRate==null ? '—' : fmt(report.winRate*100)+'%'}}</a-descriptions-item>
    <a-descriptions-item label="已平仓交易次数">{{report?.totalTrades ?? '待生成'}}</a-descriptions-item>
    <a-descriptions-item label="最大回撤"><ResultValue :value="report?.maxDrawdown" adverse /> / <ResultValue :value="report?.maxDrawdownPercent" adverse percent /></a-descriptions-item>
    <a-descriptions-item :label="includeEnd?'期末权益':'期末统计余额'">{{fmt(report?.finalEquity)}}</a-descriptions-item>
   </a-descriptions>
   <p class="help">净盈亏已扣手续费、滑点和税。浮动净盈亏扣已发生买入成本，未估计未来卖出成本；旧报告缺失项显示不可用。</p>
   <figure v-if="equity.length"><figcaption>{{includeEnd?'账户权益':'过滤后累计已实现收益曲线'}} · {{date(equity[0].time)}} — {{date(equity.at(-1).time)}}</figcaption><svg viewBox="0 0 1000 170" role="img" :aria-label="includeEnd?'账户权益曲线':'过滤后累计已实现收益曲线'"><title>起点 {{fmt(equity[0].equity)}}，终点 {{fmt(equity.at(-1).equity)}}</title><polyline :points="equityPoints" fill="none" stroke="#176b5b" stroke-width="2" /></svg></figure>
   <a-collapse v-if="!includeEnd && analytics?.original"><a-collapse-panel key="original" header="查看原始账户结果（含全部成交和浮盈）"><a-descriptions bordered size="small"><a-descriptions-item label="净盈亏"><ResultValue :value="analytics.original.totalNetPnl" /></a-descriptions-item><a-descriptions-item label="收益率"><ResultValue :value="analytics.original.returnPercent" percent /></a-descriptions-item><a-descriptions-item label="最大回撤"><ResultValue :value="analytics.original.maxDrawdown" adverse /> / <ResultValue :value="analytics.original.maxDrawdownPercent" adverse percent /></a-descriptions-item><a-descriptions-item label="期末权益">{{fmt(analytics.original.finalEquity)}}</a-descriptions-item></a-descriptions><p class="help">开启“包含结束强平及未平仓交易”可查看完整原账户曲线。</p></a-collapse-panel></a-collapse>
   <template v-if="analytics"><h3>信号汇总</h3><a-space wrap class="signal-tags"><template v-for="s in analytics.signalCounts" :key="s.type"><a-tag v-if="!filterableSignals.has(s.type)">{{labels[s.type] || s.type}}：{{s.count}}</a-tag><a-button v-else size="small" :type="selectedSignals.includes(s.type)?'primary':'default'" :aria-pressed="selectedSignals.includes(s.type)" :disabled="lowerBusy || refreshing" @click="toggleSignal(s.type)">{{labels[s.type] || s.type}}：{{s.count}}</a-button></template><a-button size="small" :disabled="!selectedSignals.length || lowerBusy || refreshing" @click="selectedSignals=[]">全部／清空筛选</a-button></a-space><a-empty v-if="!analytics.signalCounts.length" description="当前统计口径下无信号" /><p v-if="analytics.unassociatedSignals" class="help">{{analytics.unassociatedSignals}} 个历史事件无法确定所属交易，不推测过滤归属；关闭“包含结束强平及未平仓交易”时，无法确认归属的交易事件不展示。</p><a-alert v-if="analytics.missingPnl" type="warning" :message="`${analytics.missingPnl} 笔历史订单缺少净盈亏，相关统计不可用，不按零补算。`" />
    <h3>卖出原因统计</h3><a-table :scroll="{x:540}" :data-source="analytics.exitReasons" row-key="reason" :pagination="false" size="small" :columns="[{title:'原因',key:'reason'},{title:'次数',dataIndex:'count'},{title:'占比',key:'share'},{title:'净盈亏',key:'netPnl'},{title:'胜率',key:'winRate'}]"><template #bodyCell="{column,record}"><template v-if="column.key==='reason'">{{labels[record.reason] || record.reason}}</template><template v-else-if="['share','winRate'].includes(column.key)">{{record[column.key]==null?'—':fmt(record[column.key]*100)+'%'}}</template><template v-else-if="column.key==='netPnl'"><ResultValue :value="record.netPnl" /></template></template></a-table>
    <template v-if="analytics.invalidationReasons?.length"><h3>失效退出细分</h3><p class="help">退出原因与盈亏独立。多条件命中按配置顺序首个原因计一笔，明细保留全部命中条件；占比以失效退出笔数为分母。点击原因筛选下方完整交易。</p>
     <a-table :scroll="{x:600}" :data-source="analytics.invalidationReasons" row-key="code" :pagination="false" size="small" :columns="[{title:'主要触发原因',key:'code'},{title:'次数',dataIndex:'count'},{title:'占失效退出',key:'share'},{title:'净盈亏',key:'netPnl'},{title:'胜率',key:'winRate'}]">
      <template #bodyCell="{column,record}"><a-button v-if="column.key==='code'" size="small" :type="selectedSignals.includes(record.filterType)?'primary':'default'" :aria-pressed="selectedSignals.includes(record.filterType)" :disabled="lowerBusy || refreshing" @click="toggleSignal(record.filterType)">{{invalidationLabels[record.code] || record.code}}</a-button><template v-else-if="['share','winRate'].includes(column.key)">{{record[column.key]==null?'—':fmt(record[column.key]*100)+'%'}}</template><ResultValue v-else-if="column.key==='netPnl'" :value="record.netPnl" /></template>
     </a-table>
    </template>
   </template>
<p class="help" role="status">下方交易筛选：{{selectedSignals.length?selectedSignals.map(s=>labels[s]).join('、'):'全部'}}。按任一信号匹配整笔交易；顶部统计不随标签筛选变化。</p>   <div class="toolbar"><h3>CA 汇总{{selectedSignals.length?' · 筛选结果':''}}</h3><a-input-search v-model:value="search" :disabled="lowerBusy" placeholder="搜索 CA" @search="page=1;loadCas()" /><a-select v-model:value="sort" :disabled="lowerBusy" :options="[{value:'pnl_desc',label:'已实现盈亏降序'},{value:'pnl_asc',label:'已实现盈亏升序'}]" /></div>
   <a-table :loading="lowerBusy" :data-source="rows" :row-key="(r:any)=>r.chain+':'+r.ca" size="small" :scroll="{x:800}" :pagination="{disabled:lowerBusy,current:page,pageSize:20,total,showSizeChanger:false,onChange:(p:number)=>{page=p;loadCas()}}" :columns="[{title:'链',dataIndex:'chain'},{title:'CA',key:'ca'},{title:'池数',dataIndex:'poolCount'},{title:'已平仓次数',dataIndex:'trades'},{title:'已实现净盈亏',key:'realizedPnl'},{title:'浮动净盈亏',key:'unrealizedPnl'}]">
    <template #bodyCell="{column,record}"><a-button v-if="column.key==='ca'" type="link" class="address" :disabled="lowerBusy" @click="openCa(record)">{{record.ca}}</a-button><template v-else-if="['realizedPnl','unrealizedPnl'].includes(column.key)"><ResultValue :value="record[column.key]" /></template></template>
   </a-table>
   <section v-if="ca" class="ca-detail">
    <header><h3>{{ca.chain}} · {{ca.ca}}</h3><a-button @click="ca=undefined;pairId=undefined;caEpoch++">收起 CA</a-button></header>
    <a-table :data-source="ca.pools" row-key="pairId" size="small" :pagination="false" :scroll="{x:800}" :columns="[{title:'交易池',key:'pair'},{title:'状态',key:'state'},{title:'已平仓次数',dataIndex:'trades'},{title:'已实现净盈亏',key:'realizedPnl'},{title:'浮动净盈亏',key:'unrealizedPnl'},{title:'总成本（含滑点/税）',key:'fees'}]">
     <template #bodyCell="{column,record}"><a-button v-if="column.key==='pair'" class="address" type="link" :disabled="lowerBusy" @click="pairId=record.pairId">{{record.pairId}}</a-button><template v-else-if="column.key==='state'">{{record.noData===true?'无数据':record.noData===null?'历史范围':'可回测'}}</template><template v-else-if="['realizedPnl','unrealizedPnl'].includes(column.key)"><ResultValue :value="record[column.key]" /></template><template v-else-if="column.key==='fees'">{{fmt(record.fees)}}</template></template>
    </a-table>
    <div class="toolbar"><h3>K 线与事件 · {{run.config_json.interval}} / {{run.config_json.valueType==='mcap'?'市值':'价格'}}</h3><a-select v-model:value="pairId" :disabled="lowerBusy" :options="ca.pools.map((p:any)=>({value:p.pairId,label:p.pairId}))" style="min-width:260px;max-width:100%" /></div>
    <a-empty v-if="pool?.noData" description="该池在任务所选周期、类型和时间范围内无有效 K 线，未参与撮合" />
    <a-skeleton v-else-if="locating || lowerBusy" active />
    <template v-else-if="symbol && anchor"><p v-if="anchor.empty" class="help">当前筛选下该池无匹配交易，展示无交易标记的历史行情。</p><TradingViewChart :key="symbol" ref="chart" :symbol="symbol" :interval="run.config_json.interval" :run-id="run.id" :start-time="pool.startTime" :end-time="pool.endTime" :anchor="anchor" :include-end-of-backtest="includeEnd" :signal-types="selectedSignals.join(',')" /></template>
    <p v-if="hiddenUnassociated" class="help">{{hiddenUnassociated}} 个事件无法可靠关联订单，当前筛选已隐藏。</p><h3>事件时间线 · 点击定位</h3>
    <a-table :data-source="events" row-key="id" size="small" :scroll="{x:800}" :pagination="{disabled:lowerBusy,current:eventPage,pageSize:20,total:eventTotal,showSizeChanger:false,onChange:(p:number)=>eventPage=p}" :columns="[{title:'事件时间',key:'time'},{title:'事件',key:'type'},{title:run.config_json.valueType==='mcap'?'市值':'价格',key:'price'},{title:'数量',key:'quantity'},{title:'原因',key:'reason'}]">
     <template #bodyCell="{column,record}"><a-button v-if="column.key==='time'" type="link" :disabled="lowerBusy || locating" @click="chart?.focusEvent(record)">{{date(record.time)}}</a-button><template v-else-if="column.key==='type'"><a-tag>{{record.event_label}} {{labels[record.signal_type] || record.signal_type}}</a-tag><a-tag v-if="!includeEnd && record.excluded_end">不计入当前统计</a-tag></template><template v-else-if="column.key==='reason'"><ExitReason v-if="record.signal_type==='invalidation'" :record="record" /><a-tooltip v-else :title="JSON.stringify(record.reason_json)"><span>{{record.reason_json?.message || labels[record.reason_json?.priority] || '策略条件满足'}} ⓘ</span></a-tooltip></template><template v-else>{{detailValue(column.key,record[column.key])}}</template></template>
    </a-table>
    <h3>交易明细</h3>
    <a-table :data-source="trades" row-key="id" size="small" :scroll="{x:1550}" :pagination="{disabled:lowerBusy,current:tradePage,pageSize:20,total:tradeTotal,showSizeChanger:false,onChange:(p:number)=>tradePage=p}" :columns="[{title:'交易',key:'locate'},{title:'首次入场时间',key:'entry_time'},{title:'首次买入'+valueLabel,key:'first_entry_price'},{title:'平均买入'+valueLabel,key:'entry_price'},{title:'卖出'+valueLabel,key:'exit_price'},{title:'数量',key:'quantity'},{title:'退出时间',key:'exit_time'},{title:'净盈亏金额',key:'net_pnl'},{title:'净盈亏比例',key:'net_return_percent'},{title:'持仓时间',key:'holding_ms'},{title:'退出原因',key:'exit_reason'}]">
     <template #bodyCell="{column,record}"><a-button v-if="column.key==='locate'" type="link" :disabled="lowerBusy || locating" @click="locateTrade(record.id)">{{record.trade_no ? '买'+record.trade_no+' / 卖'+record.trade_no : '买卖区间'}}</a-button><template v-else-if="column.key.endsWith('_time')">{{record[column.key]!=null ? date(record[column.key]):'未平仓'}}</template><template v-else-if="column.key==='exit_reason'"><span v-if="record.trade_classification==='open'">未平仓</span><ExitReason v-else :record="record" /></template><template v-else-if="column.key==='holding_ms'">{{record.exit_time==null?'未平仓':duration(record.holding_ms)}}<small v-if="record.holding_bars!=null"> · {{record.holding_bars}} 根</small></template><template v-else-if="column.key==='net_return_percent'"><ResultValue :value="record.net_return_percent" percent /></template><template v-else-if="column.key==='net_pnl'"><ResultValue :value="record.net_pnl" /></template><template v-else>{{detailValue(column.key,record[column.key])}}</template></template>
    </a-table>
   </section>
   <a-collapse><a-collapse-panel key="snapshot" header="不可变任务配置快照"><pre>{{JSON.stringify(run.config_json,null,2)}}</pre></a-collapse-panel></a-collapse>
  </template>
 </section>
</template>
<style scoped>
.stats-filter{justify-content:flex-end}.signal-tags{margin:8px 0 16px}
.detail{background:#fff;border:1px solid #dfe6e3;border-radius:10px;padding:22px;min-width:0}header,.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0}header h2,header h3{margin:0;flex:1;overflow-wrap:anywhere}.toolbar h3{margin-right:auto}.toolbar .ant-input-search{max-width:300px}.help{font-size:12px;color:#53635e}.ca-detail{border-top:1px solid #dfe6e3;margin-top:24px;padding-top:8px}.address{height:auto;white-space:normal;text-align:left;overflow-wrap:anywhere;padding:0;max-width:380px}figure{margin:20px 0;background:#f8fafb;padding:12px}figcaption{font-size:12px;color:#53635e}svg{width:100%;max-height:210px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto}h3{font-size:16px}
</style>
