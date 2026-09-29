<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {api} from '../api';
import {beijingTime} from '../time';
import {eventLabels,formatNumber,preciseValue,signedValue,valueTone} from '../format';

const props=defineProps<{runId:string;valueType:'price'|'mcap'}>();
type Tab='current'|'history'|'signals';
const tab=ref<Tab>('current'),page=ref(1),loading=ref(false),error=ref(''),items=ref<any[]>([]),total=ref(0),summary=ref<any>();
let timer:number|undefined,epoch=0;
const dimension=computed(()=>props.valueType==='mcap'?'市值':'价格');
const headers=computed(()=>tab.value==='current'?[
 {title:'CA',dataIndex:'ca',key:'ca',width:240},{title:`买入${dimension.value}`,key:'buyValue'},{title:'买入金额（USD）',key:'buyAmount'},{title:'Token 数',key:'quantity'},{title:'首次买入时间',key:'buyTime',width:178},{title:'当前估算盈亏（USD）',key:'unrealizedPnl'},{title:'行情时间',key:'valuationTime',width:178},{title:`预计止盈${dimension.value}`,key:'takeProfitValue'},{title:`预计止损${dimension.value}`,key:'stopLossValue'}
]:tab.value==='history'?[
 {title:'CA',dataIndex:'ca',key:'ca',width:240},{title:'买入金额（USD）',key:'buyAmount'},{title:`买入${dimension.value}`,key:'buyValue'},{title:'首次买入时间',key:'buyTime',width:178},{title:`卖出${dimension.value}`,key:'sellValue'},{title:'卖出时间',key:'sellTime',width:178},{title:'卖出净额（USD）',key:'sellAmount'},{title:'净盈亏（USD / %）',key:'realizedPnl'},{title:'买入 / 卖出原因',key:'reason',width:190}
]:[
 {title:'CA',dataIndex:'ca',key:'ca',width:240},{title:'信号类型',key:'side'},{title:`决策${dimension.value}`,key:'decision_value'},{title:'信号时间',key:'decision_time',width:178},{title:'原因',key:'reason'},{title:'执行状态',key:'status'}
]);
const statusLabels:Record<string,string>={pending:'待执行',submitted:'已提交',filled:'已成交',failed:'失败',unknown:'结果待核实',cancelled:'已取消'};
function reasonText(value:string){return eventLabels[value]??({entry:'首次买入',add:'加仓'} as Record<string,string>)[value]??'原因未记录';}
function value(value:unknown){return value==null?'不可用':preciseValue(value);}
function pnlPercent(row:any){const basis=Number(row.buyAmount)+Number(row.buyCost);return basis>0?Number(row.realizedPnl)/basis*100:null;}
function cell(row:any,key:string):string{
 if(key==='ca')return row.ca;
 if(key==='buyTime'||key==='sellTime'||key==='decision_time'||key==='valuationTime')return beijingTime(row[key]);
 if(key==='side')return row.side==='buy'?'买入':'卖出';
 if(key==='reason')return tab.value==='history'?`${reasonText(row.buyReason)}${row.entryCount>1?`（含 ${row.entryCount-1} 次加仓）`:''} / ${reasonText(row.sellReason)}`:reasonText(row.reason);
 if(key==='status')return statusLabels[row.status]??'状态未识别';
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
 if(id!==epoch)return;items.value=data.items;total.value=data.total;summary.value=data.summary;
}catch{if(id===epoch)error.value='持仓与信号加载失败，请重试';}finally{if(id===epoch)loading.value=false;}}
watch([()=>props.runId,tab],()=>{page.value=1;items.value=[];void load();});
watch(page,()=>void load());
onMounted(()=>{void load();timer=window.setInterval(()=>void load(),5000);});
onBeforeUnmount(()=>{epoch++;window.clearInterval(timer);});
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
  <a-table class="portfolio-table" :columns="headers" :data-source="items" row-key="id" size="small" :loading="loading" :scroll="{x:tab==='history'?1500:1200}" :pagination="{current:page,pageSize:20,total,showSizeChanger:false,showTotal:(n:number)=>`共 ${n} 条`}" :locale="{emptyText:tab==='current'?'暂无已核实的当前持仓':tab==='history'?'暂无已完成的历史持仓':'暂无买卖决策'}" @change="(p:any)=>page=p.current??1">
   <template #bodyCell="{column,record}"><span :class="cellTone(String(column.key),record)" :title="column.key==='unrealizedPnl'&&record.valuationTime?`行情时间：${beijingTime(record.valuationTime)}`:undefined">{{cell(record,String(column.key))}}</span></template>
  </a-table>
  <div class="portfolio-mobile" :aria-busy="loading"><a-empty v-if="!items.length&&!loading" :description="tab==='current'?'暂无已核实的当前持仓':tab==='history'?'暂无已完成的历史持仓':'暂无买卖决策'" />
   <article v-for="row in items" :key="row.id" class="portfolio-mobile-row"><strong class="portfolio-ca">{{row.ca}}</strong><dl><template v-for="column in headers.filter(c=>c.key!=='ca')" :key="column.key"><dt>{{column.title}}</dt><dd :class="cellTone(String(column.key),row)">{{cell(row,String(column.key))}}</dd></template></dl></article>
   <a-pagination v-if="total>20" v-model:current="page" :page-size="20" :total="total" simple />
  </div>
 </section>
</template>

<style scoped>
.portfolio{margin-top:24px}.portfolio-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.portfolio-heading h3{margin:0;font-size:16px}.portfolio-heading span,.portfolio-note{color:#53615d;font-size:12px}.portfolio-summary{display:flex;flex-wrap:wrap;gap:10px 24px;padding:14px 0;border-block:1px solid #e8eeeb;margin-top:12px}.portfolio-summary>span{font-size:12px;color:#53615d}.portfolio-summary strong{display:block;font-size:15px;color:#18211f;font-variant-numeric:tabular-nums}.portfolio-summary strong.value-positive,.value-positive{color:#2f7d5b}.portfolio-summary strong.value-negative,.value-negative{color:#c2413b}.portfolio-summary small{font-size:11px;color:#53615d}.portfolio-note{margin:10px 0 14px}.portfolio-alert{margin:12px 0}.portfolio-table :deep(.ant-table-cell){font-variant-numeric:tabular-nums}.portfolio-table :deep(.ant-table-cell:first-child){overflow-wrap:anywhere}.portfolio-mobile{display:none}.portfolio-ca{overflow-wrap:anywhere}.portfolio-mobile-row{padding:14px 0;border-bottom:1px solid #e8eeeb}.portfolio-mobile-row dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:8px 14px;margin:10px 0 0;font-size:12px}.portfolio-mobile-row dt{color:#53615d}.portfolio-mobile-row dd{margin:0;text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
@media(max-width:700px){.portfolio-heading{align-items:flex-start;flex-direction:column;gap:2px}.portfolio-summary{gap:12px 18px}.portfolio-summary>span{min-width:calc(50% - 18px)}.portfolio-table{display:none}.portfolio-mobile{display:block}.portfolio :deep(.ant-tabs-nav-list){min-width:max-content}.portfolio :deep(.ant-tabs-nav-wrap){overflow:auto}}
</style>
