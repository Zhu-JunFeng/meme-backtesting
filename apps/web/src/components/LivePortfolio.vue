<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {api} from '../api';
import {beijingTime} from '../time';
import {eventLabels,formatNumber,preciseValue,signedValue,valueTone} from '../format';
import ProjectIdentity from './ProjectIdentity.vue';

const props=defineProps<{runId:string;valueType:'price'|'mcap'}>();
const emit=defineEmits<{selectPosition:[id:string];selectSignal:[id:string]}>();
type Tab='current'|'history'|'signals';
const tab=ref<Tab>('current'),page=ref(1),loading=ref(false),error=ref(''),items=ref<any[]>([]),total=ref(0),summary=ref<any>();
let timer:number|undefined,clockTimer:number|undefined,epoch=0,receivedAt=0;
const clock=ref(Date.now()),serverAsOf=ref(Date.now());
const dimension=computed(()=>props.valueType==='mcap'?'市值':'价格');
const headers=computed(()=>tab.value==='current'?[
 {title:'项目',key:'ca',width:240},{title:'买入与数量',key:'entry',width:190},{title:'持仓',key:'holding',width:185},{title:'当前盈亏',key:'unrealizedPnl',width:170},{title:'预计退出位',key:'risk',width:180},{title:'K 线',key:'locate',width:90}
]:tab.value==='history'?[
 {title:'项目',key:'ca',width:240},{title:'买入',key:'entry',width:210},{title:'卖出',key:'exit',width:210},{title:'净盈亏',key:'realizedPnl',width:170},{title:'持仓与原因',key:'outcome',width:215},{title:'K 线',key:'locate',width:90}
]:[
 {title:'项目',key:'ca',width:260},{title:'信号',key:'signal',width:200},{title:'决策时间',key:'decision_time',width:180},{title:'执行状态',key:'status',width:130},{title:'K 线',key:'locate',width:90}
]);
const statusLabels:Record<string,string>={pending:'待执行',submitted:'已提交',filled:'已成交',failed:'失败',unknown:'结果待核实',cancelled:'已取消'};
function reasonText(value:string){return eventLabels[value]??({entry:'首次买入',add:'加仓'} as Record<string,string>)[value]??'原因未记录';}
function value(value:unknown){return value==null?'不可用':preciseValue(value);}
function pnlPercent(row:any){const basis=Number(row.buyAmount)+Number(row.buyCost);return basis>0?Number(row.realizedPnl)/basis*100:null;}
function duration(row:any){const start=Number(row.buyTime),end=row.sellTime==null?serverAsOf.value+Math.max(0,clock.value-receivedAt):Number(row.sellTime);if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)return '不可用';const seconds=Math.floor((end-start)/1000),days=Math.floor(seconds/86400),hours=Math.floor(seconds%86400/3600),minutes=Math.floor(seconds%3600/60);return `${days?days+' 天 ':''}${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}
function cell(row:any,key:string):string{
 if(key==='ca')return row.ca;
 if(key==='buyTime'||key==='sellTime'||key==='decision_time'||key==='valuationTime')return beijingTime(row[key]);
 if(key==='side')return row.side==='buy'?'买入':'卖出';
 if(key==='reason')return tab.value==='history'?`${reasonText(row.buyReason)}${row.entryCount>1?`（含 ${row.entryCount-1} 次加仓）`:''} / ${reasonText(row.sellReason)}`:reasonText(row.reason);
 if(key==='status')return statusLabels[row.status]??'状态未识别';
 if(key==='holdDuration')return duration(row);
 if(key==='buyAmount')return formatNumber(row.buyAmount);
 if(key==='quantity')return preciseValue(row.quantity);
 if(key==='unrealizedPnl')return row.unrealizedPnl==null?'不可用':signedValue(row.unrealizedPnl);
 if(key==='realizedPnl')return `${signedValue(row.realizedPnl)} / ${pnlPercent(row)==null?'不可用':signedValue(pnlPercent(row))+'%'}`;
 if(key==='takeProfitValue'||key==='stopLossValue')return value(row[key]);
 if(key==='sellAmount')return formatNumber(row.sellAmount);
 return value(row[key]);
}
function cellTone(key:string,row:any){return key==='unrealizedPnl'||key==='realizedPnl'?valueTone(row[key]):'';}
async function load(){const id=++epoch;loading.value=true;error.value='';try{
 const data=(await api.get(`/live-runs/${props.runId}/portfolio`,{params:{tab:tab.value,page:page.value,pageSize:20}})).data;
 if(id!==epoch)return;items.value=data.items;total.value=data.total;summary.value=data.summary;serverAsOf.value=Number(data.asOf)||Date.now();receivedAt=Date.now();clock.value=receivedAt;
}catch{if(id===epoch)error.value='持仓与信号加载失败，请重试';}finally{if(id===epoch)loading.value=false;}}
watch([()=>props.runId,tab],()=>{page.value=1;items.value=[];void load();});
watch(page,()=>void load());
onMounted(()=>{void load();timer=window.setInterval(()=>void load(),5000);clockTimer=window.setInterval(()=>{clock.value=Date.now();},1000);});
onBeforeUnmount(()=>{epoch++;window.clearInterval(timer);window.clearInterval(clockTimer);});
</script>

<template>
 <section class="portfolio" aria-label="持仓和买卖信号">
  <div class="portfolio-heading"><h3>持仓与买卖信号</h3><span>当前任务统计 · 每 5 秒更新</span></div>
  <div v-if="summary" class="portfolio-summary" aria-label="当前任务汇总">
   <span>当前持仓 <strong>{{summary.openCount}}</strong></span><span>持仓成本 <strong>{{formatNumber(summary.openCost)}} USD</strong></span>
   <span>估算浮盈亏 <strong :class="valueTone(summary.unrealizedPnl)">{{summary.unrealizedPnl==null?'不可用':signedValue(summary.unrealizedPnl)}}<small v-if="summary.unpricedCount"> {{summary.unpricedCount}} 笔无新鲜行情</small></strong></span>
   <span>历史持仓 <strong>{{summary.closedCount}}</strong></span><span>已平仓净盈亏 <strong :class="valueTone(summary.realizedPnl)">{{signedValue(summary.realizedPnl)}} USD</strong></span>
   <span>胜率 <strong>{{summary.winRate==null?'—':formatNumber(summary.winRate)+'%'}}</strong></span>
   <span>买入 / 卖出信号 <strong>{{summary.buySignalCount}} / {{summary.sellSignalCount}}</strong></span>
   <span v-if="summary.unverifiedOrderCount">待执行或待核实订单 <strong>{{summary.unverifiedOrderCount}}</strong></span>
  </div>
  <p class="portfolio-note">持仓浮盈亏按最近可信行情及策略卖出成本估算，不是已实现收益。实盘仅以已核实成交统计；结果未明的订单不会计入持仓。</p>
  <p v-if="summary&&Math.abs(Number(summary.accountRealizedPnl)-Number(summary.realizedPnl))>0.01" class="portfolio-note">账户已实现盈亏为 {{signedValue(summary.accountRealizedPnl)}} USD；上方历史持仓仅汇总已完整平仓且可关联的交易，不包含未平仓的部分卖出或不完整记录。</p>
  <a-alert v-if="summary?.incompleteCount" type="warning" show-icon :message="`${summary.incompleteCount} 条成交历史不完整或归属不明，未猜测其持仓及盈亏`" class="portfolio-alert" />
  <a-alert v-if="error" type="error" show-icon :message="error" class="portfolio-alert"><template #action><a-button size="small" @click="load">重试</a-button></template></a-alert>
  <a-tabs v-model:activeKey="tab" :animated="false">
   <a-tab-pane key="current" :tab="`当前持仓${summary?` (${summary.openCount})`:''}`" />
   <a-tab-pane key="history" :tab="`历史持仓${summary?` (${summary.closedCount})`:''}`" />
   <a-tab-pane key="signals" :tab="`买／卖信号${summary?` (${summary.buySignalCount+summary.sellSignalCount})`:''}`" />
  </a-tabs>
  <div class="portfolio-tab-context"><strong>{{tab==='current'?'当前持仓':tab==='history'?'历史持仓':'买／卖信号'}} · {{total}} 条</strong><span>{{tab==='current'?'先看浮盈亏与预计退出位；估值取最近可信行情。':tab==='history'?'买卖金额均含对应成交口径；净盈亏扣除成本。':'显示全部决策，未成交信号不会计入持仓和胜率。'}}</span></div>
  <a-table class="portfolio-table" :columns="headers" :data-source="items" row-key="id" size="small" :loading="loading" :scroll="{x:tab==='signals'?900:1080}" :pagination="{current:page,pageSize:20,total,showSizeChanger:false,showTotal:(n:number)=>`共 ${n} 条`}" :locale="{emptyText:tab==='current'?'暂无已核实的当前持仓':tab==='history'?'暂无已完成的历史持仓':'暂无买卖决策'}" @change="(p:any)=>page=p.current??1">
   <template #bodyCell="{column,record}">
    <a-button v-if="column.key==='locate'" type="link" size="small" @click="tab==='signals'?emit('selectSignal',record.id):emit('selectPosition',record.id)">查看点位</a-button>
    <ProjectIdentity v-else-if="column.key==='ca'" :chain="record.chain" :ca="record.ca" />
    <span v-else-if="column.key==='entry'" class="portfolio-cell-stack"><strong>{{cell(record,'buyAmount')}} USD</strong><small>买入{{dimension}} {{cell(record,'buyValue')}}</small><small>Token {{cell(record,'quantity')}}</small><small v-if="tab==='history'">{{cell(record,'buyTime')}}</small></span>
    <span v-else-if="column.key==='holding'" class="portfolio-cell-stack"><strong>{{cell(record,'holdDuration')}}</strong><small>买入 {{cell(record,'buyTime')}}</small></span>
    <span v-else-if="column.key==='exit'" class="portfolio-cell-stack"><strong>{{cell(record,'sellAmount')}} USD</strong><small>卖出{{dimension}} {{cell(record,'sellValue')}}</small><small>{{cell(record,'sellTime')}}</small></span>
    <span v-else-if="column.key==='risk'" class="portfolio-cell-stack"><small>止盈 {{cell(record,'takeProfitValue')}}</small><small>止损 {{cell(record,'stopLossValue')}}</small></span>
    <span v-else-if="column.key==='outcome'" class="portfolio-cell-stack"><strong>{{cell(record,'holdDuration')}}</strong><small>{{cell(record,'reason')}}</small></span>
    <span v-else-if="column.key==='signal'" class="portfolio-cell-stack"><strong>{{cell(record,'side')}} · {{cell(record,'reason')}}</strong><small>决策{{dimension}} {{cell(record,'decision_value')}}</small></span>
    <span v-else :class="[cellTone(String(column.key),record),'portfolio-cell-stack']" :title="column.key==='unrealizedPnl'&&record.valuationTime?`行情时间：${beijingTime(record.valuationTime)}`:undefined"><strong>{{cell(record,String(column.key))}}{{column.key==='unrealizedPnl'&&record.unrealizedPnl!=null?' USD':''}}</strong><small v-if="column.key==='unrealizedPnl'">行情 {{cell(record,'valuationTime')}}</small></span>
   </template>
  </a-table>
  <div class="portfolio-mobile" :aria-busy="loading"><a-empty v-if="!items.length&&!loading" :description="tab==='current'?'暂无已核实的当前持仓':tab==='history'?'暂无已完成的历史持仓':'暂无买卖决策'" />
   <article v-for="row in items" :key="row.id" class="portfolio-mobile-row">
    <div class="portfolio-mobile-top"><ProjectIdentity :chain="row.chain" :ca="row.ca" /><strong v-if="tab!=='signals'" :class="cellTone(tab==='current'?'unrealizedPnl':'realizedPnl',row)">{{tab==='current'?cell(row,'unrealizedPnl'):cell(row,'realizedPnl')}}</strong><a-tag v-else :color="row.side==='buy'?'green':'red'">{{cell(row,'side')}}</a-tag></div>
    <dl v-if="tab==='current'"><dt>买入金额 / {{dimension}}</dt><dd>{{cell(row,'buyAmount')}} USD / {{cell(row,'buyValue')}}</dd><dt>Token 数</dt><dd>{{cell(row,'quantity')}}</dd><dt>买入时间</dt><dd>{{cell(row,'buyTime')}}</dd><dt>持仓时间</dt><dd>{{cell(row,'holdDuration')}}</dd><dt>预计止盈 / 止损</dt><dd>{{cell(row,'takeProfitValue')}} / {{cell(row,'stopLossValue')}}</dd><dt>行情时间</dt><dd>{{cell(row,'valuationTime')}}</dd></dl>
    <dl v-else-if="tab==='history'"><dt>买入金额 / {{dimension}}</dt><dd>{{cell(row,'buyAmount')}} USD / {{cell(row,'buyValue')}}</dd><dt>买入时间</dt><dd>{{cell(row,'buyTime')}}</dd><dt>卖出净额 / {{dimension}}</dt><dd>{{cell(row,'sellAmount')}} USD / {{cell(row,'sellValue')}}</dd><dt>卖出时间</dt><dd>{{cell(row,'sellTime')}}</dd><dt>持仓时间</dt><dd>{{cell(row,'holdDuration')}}</dd><dt>买入 / 卖出原因</dt><dd>{{cell(row,'reason')}}</dd></dl>
    <dl v-else><dt>信号与原因</dt><dd>{{cell(row,'reason')}}</dd><dt>决策{{dimension}}</dt><dd>{{cell(row,'decision_value')}}</dd><dt>信号时间</dt><dd>{{cell(row,'decision_time')}}</dd><dt>执行状态</dt><dd>{{cell(row,'status')}}</dd></dl>
    <a-button class="portfolio-mobile-action" size="small" @click="tab==='signals'?emit('selectSignal',row.id):emit('selectPosition',row.id)">在 K 线查看点位</a-button>
   </article>
   <a-pagination v-if="total>20" v-model:current="page" :page-size="20" :total="total" simple />
  </div>
 </section>
</template>

<style scoped>
.portfolio{margin-top:24px}.portfolio-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.portfolio-heading h3{margin:0;font-size:16px}.portfolio-heading span,.portfolio-note{color:#53615d;font-size:12px}.portfolio-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px;margin-top:12px}.portfolio-summary>span{padding:11px 13px;border:1px solid #e8eeeb;border-radius:8px;font-size:12px;color:#53615d}.portfolio-summary strong{display:block;margin-top:4px;font-size:15px;color:#18211f;font-variant-numeric:tabular-nums}.portfolio-summary strong.value-positive,.value-positive{color:#2f7d5b}.portfolio-summary strong.value-negative,.value-negative{color:#c2413b}.portfolio-summary small{font-size:11px;color:#53615d}.portfolio-note{margin:10px 0 14px}.portfolio-alert{margin:12px 0}.portfolio-tab-context{display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin:0 0 12px;font-size:12px;color:#53615d}.portfolio-tab-context strong{color:#18211f;font-size:14px}.portfolio-table :deep(.ant-table-cell){font-variant-numeric:tabular-nums;vertical-align:top}.portfolio-cell-stack,.portfolio-cell-stack small,.portfolio-cell-stack strong{display:block}.portfolio-cell-stack small{color:#53615d;margin-top:4px;font-size:11px}.portfolio-ca{display:block;overflow-wrap:anywhere}.portfolio-mobile{display:none}.portfolio-mobile-row{padding:15px;margin:10px 0;border:1px solid #e8eeeb;border-radius:9px}.portfolio-mobile-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.portfolio-mobile-top>strong:last-child{font-variant-numeric:tabular-nums;white-space:nowrap}.portfolio-mobile-row dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:8px 14px;margin:14px 0;font-size:12px}.portfolio-mobile-row dt{color:#53615d}.portfolio-mobile-row dd{margin:0;text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.portfolio-mobile-action{width:100%}
.portfolio-summary{gap:0;border:1px solid #e8eeeb;border-radius:8px;overflow:hidden}.portfolio-summary>span{border:0;border-right:1px solid #e8eeeb;border-bottom:1px solid #e8eeeb;border-radius:0;min-width:0}
@media(max-width:700px){.portfolio-heading{align-items:flex-start;flex-direction:column;gap:2px}.portfolio-summary{grid-template-columns:repeat(2,minmax(0,1fr))}.portfolio-summary>span{min-width:0}.portfolio-tab-context{align-items:flex-start;flex-direction:column;gap:3px}.portfolio-mobile-top{align-items:flex-start;flex-direction:column;gap:7px}.portfolio-mobile-top>strong:last-child{white-space:normal}.portfolio-table{display:none}.portfolio-mobile{display:block}.portfolio :deep(.ant-tabs-nav-list){min-width:max-content}.portfolio :deep(.ant-tabs-nav-wrap){overflow:auto}}
</style>
