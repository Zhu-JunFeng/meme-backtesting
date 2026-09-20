<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { api } from "../api";
import TradingViewChart from "./TradingViewChart.vue";
import RunActions from './RunActions.vue';
const props=defineProps<{runId:string}>();defineEmits(["back"]);
const run=ref<any>(),report=ref<any>(),summary=ref<any>(),rows=ref<any[]>([]),equity=ref<any[]>([]);
const loading=ref(false),error=ref(""),search=ref(""),sort=ref("pnl_desc"),page=ref(1),total=ref(0);
const ca=ref<any>(),pairId=ref<string>(),events=ref<any[]>([]),trades=ref<any[]>([]);
const eventPage=ref(1),tradePage=ref(1),eventTotal=ref(0),tradeTotal=ref(0),chart=ref<any>();
const anchor=ref<any>(),locating=ref(false);
let epoch=0,caEpoch=0,poolEpoch=0,locateEpoch=0,timer:number|undefined;
const pool=computed(()=>ca.value?.pools?.find((p:any)=>p.pairId===pairId.value));
const symbol=computed(()=>pool.value ? [pool.value.chain,pool.value.ca,pool.value.pairId,run.value.config_json.valueType].join(":"):"");
const labels:Record<string,string>={entry:"首次买入",add:"加仓",take_profit:"止盈卖出",stop_loss:"止损卖出",invalidation:"失效退出",timeout:"超时退出",end_of_backtest:"结束平仓",risk_event:"风险事件"};
const fmt=(n:any)=>n===null || n===undefined?"不可用":Number(n).toLocaleString("zh-CN",{maximumFractionDigits:6});
const date=(n:any)=>n===null || n===undefined?"不可用":new Date(Number(n)).toLocaleString();
const equityPoints=computed(()=>{
 if(!equity.value.length)return "";
 const values=equity.value.map(p=>Number(p.equity)),min=Math.min(...values),max=Math.max(...values),span=max-min || 1;
 const start=Number(equity.value[0].time),duration=Number(equity.value.at(-1).time)-start || 1;
 return equity.value.map(p=>`${10+(Number(p.time)-start)/duration*980},${150-(Number(p.equity)-min)/span*130}`).join(" ");
});
async function loadCas() {
 const request=++epoch;
 try {const {data}=await api.get(`/backtests/${props.runId}/cas`,{params:{ca:search.value,sort:sort.value,page:page.value,pageSize:20}});if(request!==epoch)return;rows.value=data.items;total.value=data.total;summary.value=data.summary;}
 catch(e:any){if(request===epoch)error.value=e.response?.data?.message || "CA 列表加载失败";}
}
async function load() {
 loading.value=!run.value;error.value="";
 try {
 const [a,b,c]=await Promise.all([api.get(`/backtests/${props.runId}`),api.get(`/backtests/${props.runId}/report`),api.get(`/backtests/${props.runId}/equity`)]);
 run.value=a.data;report.value=b.data;equity.value=c.data;await loadCas();
 if(ca.value)await openCa(ca.value,true);
 }catch(e:any){error.value=e.response?.data?.message || "详情加载失败";}finally{loading.value=false;}
}
async function openCa(row:any,preserve=false) {
 const request=++caEpoch;
 if(!preserve){ca.value=undefined;pairId.value=undefined;events.value=[];trades.value=[];poolEpoch++;}
 try {
 const {data}=await api.get(`/backtests/${props.runId}/ca`,{params:{chain:row.chain,ca:row.ca}});
 if(request!==caEpoch)return;ca.value=data;
 if(!preserve)pairId.value=data?.pools?.find((p:any)=>p.trades>0)?.pairId ?? data?.pools?.find((p:any)=>!p.noData)?.pairId ?? data?.pools?.[0]?.pairId;
 }catch{error.value="CA 详情加载失败";}
}
async function loadPool() {
 const request=++poolEpoch;events.value=[];trades.value=[];eventTotal.value=0;tradeTotal.value=0;
 if(!pool.value)return;
 const params={chain:pool.value.chain,ca:pool.value.ca,pairId:pairId.value,pageSize:20};
 try {
 const [a,b]=await Promise.all([api.get(`/backtests/${props.runId}/signals`,{params:{...params,page:eventPage.value}}),api.get(`/backtests/${props.runId}/trades`,{params:{...params,page:tradePage.value}})]);
 if(request!==poolEpoch)return;
 events.value=a.data.items;eventTotal.value=a.data.total;trades.value=b.data.items;tradeTotal.value=b.data.total;
 }catch{if(request===poolEpoch)error.value="交易或事件加载失败";}
}
async function locateTrade(tradeId?:string){
 const epoch=++locateEpoch;anchor.value=undefined;locating.value=true;
 try{const {data}=await api.get(`/backtests/${props.runId}/locate`,{params:{chain:pool.value.chain,ca:pool.value.ca,pairId:pairId.value,tradeId}});if(epoch===locateEpoch)anchor.value=data;}
 catch{if(epoch===locateEpoch)error.value='买卖区间定位失败，请重新选择交易池';}finally{if(epoch===locateEpoch)locating.value=false;}
}
watch(pairId,()=>{locateEpoch++;eventPage.value=1;tradePage.value=1;anchor.value=undefined;if(!pool.value)return;void loadPool();void locateTrade();});
watch([eventPage,tradePage],loadPool);
watch(sort,()=>{page.value=1;loadCas();});
onMounted(()=>{load();timer=window.setInterval(()=>{if(["pending","running","stopping"].includes(run.value?.status))load();},5000);});
onBeforeUnmount(()=>{epoch++;caEpoch++;poolEpoch++;locateEpoch++;window.clearInterval(timer);});
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
   <a-descriptions v-if="summary" bordered size="small" :column="{xs:1,sm:2,lg:4}">
    <a-descriptions-item label="CA 总数">{{summary.caCount}}</a-descriptions-item>
    <a-descriptions-item label="有交易 / 无交易 CA">{{summary.tradedCaCount}} / {{summary.untradedCaCount}}</a-descriptions-item>
    <a-descriptions-item label="交易池">{{summary.poolCount}}</a-descriptions-item>
    <a-descriptions-item label="无数据池">{{run.config_json.pools ? summary.noDataPoolCount : '历史任务未记录'}}</a-descriptions-item>
    <a-descriptions-item label="已实现净盈亏">{{fmt(report?.netPnl)}}</a-descriptions-item>
    <a-descriptions-item label="浮动净盈亏">{{fmt(report?.unrealizedPnl)}}</a-descriptions-item>
    <a-descriptions-item label="整体净盈亏">{{fmt(report?.totalNetPnl ?? report?.netPnl)}}</a-descriptions-item>
    <a-descriptions-item label="收益率">{{fmt(report?.returnPercent)}}%</a-descriptions-item>
    <a-descriptions-item label="胜率">{{report ? fmt(report.winRate*100)+'%' : '待生成'}}</a-descriptions-item>
    <a-descriptions-item label="已平仓交易次数">{{report?.totalTrades ?? '待生成'}}</a-descriptions-item>
    <a-descriptions-item label="最大回撤">{{fmt(report?.maxDrawdown)}} / {{fmt(report?.maxDrawdownPercent)}}%</a-descriptions-item>
    <a-descriptions-item label="期末权益">{{fmt(report?.finalEquity)}}</a-descriptions-item>
   </a-descriptions>
   <p class="help">净盈亏已扣手续费、滑点和税。浮动净盈亏扣已发生买入成本，未估计未来卖出成本；旧报告缺失项显示不可用。</p>
   <figure v-if="equity.length"><figcaption>账户权益 · {{date(equity[0].time)}} — {{date(equity.at(-1).time)}}</figcaption><svg viewBox="0 0 1000 170" role="img" aria-label="账户权益曲线"><title>起点 {{fmt(equity[0].equity)}}，终点 {{fmt(equity.at(-1).equity)}}</title><polyline :points="equityPoints" fill="none" stroke="#176b5b" stroke-width="2" /></svg></figure>
   <div class="toolbar"><h3>CA 汇总</h3><a-input-search v-model:value="search" placeholder="搜索 CA" @search="page=1;loadCas()" /><a-select v-model:value="sort" :options="[{value:'pnl_desc',label:'已实现盈亏降序'},{value:'pnl_asc',label:'已实现盈亏升序'}]" /></div>
   <a-table :data-source="rows" :row-key="(r:any)=>r.chain+':'+r.ca" size="small" :scroll="{x:800}" :pagination="{current:page,pageSize:20,total,showSizeChanger:false,onChange:(p:number)=>{page=p;loadCas()}}" :columns="[{title:'链',dataIndex:'chain'},{title:'CA',key:'ca'},{title:'池数',dataIndex:'poolCount'},{title:'已平仓次数',dataIndex:'trades'},{title:'已实现净盈亏',key:'realizedPnl'},{title:'浮动净盈亏',key:'unrealizedPnl'}]">
    <template #bodyCell="{column,record}"><a-button v-if="column.key==='ca'" type="link" class="address" @click="openCa(record)">{{record.ca}}</a-button><template v-else-if="['realizedPnl','unrealizedPnl'].includes(column.key)">{{fmt(record[column.key])}}</template></template>
   </a-table>
   <section v-if="ca" class="ca-detail">
    <header><h3>{{ca.chain}} · {{ca.ca}}</h3><a-button @click="ca=undefined;pairId=undefined;caEpoch++">收起 CA</a-button></header>
    <a-table :data-source="ca.pools" row-key="pairId" size="small" :pagination="false" :scroll="{x:800}" :columns="[{title:'交易池',key:'pair'},{title:'状态',key:'state'},{title:'已平仓次数',dataIndex:'trades'},{title:'已实现净盈亏',key:'realizedPnl'},{title:'浮动净盈亏',key:'unrealizedPnl'},{title:'总成本（含滑点/税）',key:'fees'}]">
     <template #bodyCell="{column,record}"><a-button v-if="column.key==='pair'" class="address" type="link" @click="pairId=record.pairId">{{record.pairId}}</a-button><template v-else-if="column.key==='state'">{{record.noData===true?'无数据':record.noData===null?'历史范围':'可回测'}}</template><template v-else-if="['realizedPnl','unrealizedPnl','fees'].includes(column.key)">{{fmt(record[column.key])}}</template></template>
    </a-table>
    <div class="toolbar"><h3>K 线与事件 · {{run.config_json.interval}} / {{run.config_json.valueType==='mcap'?'市值':'价格'}}</h3><a-select v-model:value="pairId" :options="ca.pools.map((p:any)=>({value:p.pairId,label:p.pairId}))" style="min-width:260px;max-width:100%" /></div>
    <a-empty v-if="pool?.noData" description="该池在任务所选周期、类型和时间范围内无有效 K 线，未参与撮合" />
    <a-skeleton v-else-if="locating" active />
    <template v-else-if="symbol && anchor"><p v-if="anchor.empty" class="help">该池尚无交易，展示历史末尾行情。</p><TradingViewChart :key="symbol" ref="chart" :symbol="symbol" :interval="run.config_json.interval" :run-id="run.id" :start-time="pool.startTime" :end-time="pool.endTime" :anchor="anchor" /></template>
    <h3>事件时间线 · 点击定位</h3>
    <a-table :data-source="events" row-key="id" size="small" :scroll="{x:800}" :pagination="{current:eventPage,pageSize:20,total:eventTotal,showSizeChanger:false,onChange:(p:number)=>eventPage=p}" :columns="[{title:'事件时间',key:'time'},{title:'事件',key:'type'},{title:run.config_json.valueType==='mcap'?'市值':'价格',key:'price'},{title:'数量',key:'quantity'},{title:'原因',key:'reason'}]">
     <template #bodyCell="{column,record}"><a-button v-if="column.key==='time'" type="link" @click="chart?.focusEvent(record)">{{date(record.time)}}</a-button><a-tag v-else-if="column.key==='type'">{{labels[record.signal_type] || record.signal_type}}</a-tag><template v-else-if="column.key==='reason'"><a-tooltip :title="JSON.stringify(record.reason_json)"><span>{{record.reason_json?.message || labels[record.reason_json?.priority] || '策略条件满足'}} ⓘ</span></a-tooltip></template><template v-else>{{fmt(record[column.key])}}</template></template>
    </a-table>
    <h3>交易明细</h3>
    <a-table :data-source="trades" row-key="id" size="small" :scroll="{x:850}" :pagination="{current:tradePage,pageSize:20,total:tradeTotal,showSizeChanger:false,onChange:(p:number)=>tradePage=p}" :columns="[{title:'查看',key:'locate'},{title:'首次入场时间',key:'entry_time'},{title:'平均成本',key:'entry_price'},{title:'数量',key:'quantity'},{title:'退出时间',key:'exit_time'},{title:'净盈亏',key:'net_pnl'},{title:'退出原因',key:'exit_reason'}]">
     <template #bodyCell="{column,record}"><a-button v-if="column.key==='locate'" type="link" @click="locateTrade(record.id)">买卖区间</a-button><template v-else-if="column.key.endsWith('_time')">{{record[column.key] ? date(record[column.key]):'未平仓'}}</template><template v-else-if="column.key==='exit_reason'">{{labels[record.exit_reason] || '未平仓'}}</template><template v-else>{{fmt(record[column.key])}}</template></template>
    </a-table>
   </section>
   <a-collapse><a-collapse-panel key="snapshot" header="不可变任务配置快照"><pre>{{JSON.stringify(run.config_json,null,2)}}</pre></a-collapse-panel></a-collapse>
  </template>
 </section>
</template>
<style scoped>
.detail{background:#fff;border:1px solid #dfe6e3;border-radius:10px;padding:22px;min-width:0}header,.toolbar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0}header h2,header h3{margin:0;flex:1;overflow-wrap:anywhere}.toolbar h3{margin-right:auto}.toolbar .ant-input-search{max-width:300px}.help{font-size:12px;color:#53635e}.ca-detail{border-top:1px solid #dfe6e3;margin-top:24px;padding-top:8px}.address{height:auto;white-space:normal;text-align:left;overflow-wrap:anywhere;padding:0;max-width:380px}figure{margin:20px 0;background:#f8fafb;padding:12px}figcaption{font-size:12px;color:#53635e}svg{width:100%;max-height:210px}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:400px;overflow:auto}h3{font-size:16px}
</style>
