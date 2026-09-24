<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {message,Modal} from 'ant-design-vue';
import {api} from '../api';
import {beijingTime} from '../time';
import {formatNumber,signedValue,valueTone,preciseValue} from '../format';
import TradingViewChart from './TradingViewChart.vue';

const props=defineProps<{mode:'paper'|'live'}>();
const templates=ref<any[]>([]),versions=ref<any[]>([]),runs=ref<any[]>([]),detail=ref<any>();
const templateId=ref<string>(),versionId=ref<string>(),selectedRunId=ref<string>(),selectedWatch=ref<string>();
const password=ref(''),authorized=ref(false),loading=ref(false),busy=ref(false),chartEpoch=ref(0);
const form=ref({name:'',chain:'sol',interval:'30s',valueType:'mcap',initialCapital:1000,walletAddress:'',maxOrderNative:0.01,maxTotalNative:0.05,maxDailyLossUsd:20,maxPositions:1,tip:0.001,slippagePercent:5});
const columns=[{title:'时间',dataIndex:'created_at',key:'created_at'},{title:'CA / 交易池',dataIndex:'ca',key:'ca'},{title:'方向',dataIndex:'side',key:'side'},{title:'原因',dataIndex:'reason',key:'reason'},{title:'状态',dataIndex:'status',key:'status'},{title:'成交价',dataIndex:'fill_price',key:'fill_price'},{title:'数量',dataIndex:'quantity',key:'quantity'}];
const current=computed(()=>runs.value.find(r=>r.id===selectedRunId.value));
const secureAdminContext=window.location.protocol==='https:'||['localhost','127.0.0.1'].includes(window.location.hostname);
const chosenWatch=computed(()=>detail.value?.watches?.find((w:any)=>`${w.chain}:${w.ca}:${w.pair_id}`===selectedWatch.value));
const chartSymbol=computed(()=>chosenWatch.value?`${chosenWatch.value.chain}:${chosenWatch.value.ca}:${chosenWatch.value.pair_id}:${detail.value.run.value_type}`:'');
const real=props.mode==='live';let timer:number|undefined,request=0;
function statusText(s:string){return ({paused:'已暂停',running:'运行中',stopped:'已停止',attention:'待人工处理'} as Record<string,string>)[s]??s;}
function statusColor(s:string){return ({paused:'default',running:'green',stopped:'default',attention:'red'} as Record<string,string>)[s]??'default';}
function adminHeader(){return real?{'x-live-admin-password':password.value}:{};}
async function loadVersions(){if(!templateId.value)return;versions.value=(await api.get(`/strategy-templates/${templateId.value}/versions`)).data;versionId.value=templates.value.find(t=>t.id===templateId.value)?.currentVersionId??versions.value[0]?.id;}
async function refresh(){
 try{runs.value=(await api.get('/live-runs',{params:{mode:props.mode}})).data;
  if(selectedRunId.value&&!runs.value.some(r=>r.id===selectedRunId.value)){selectedRunId.value=undefined;detail.value=undefined;}
  if(selectedRunId.value)await loadDetail(selectedRunId.value);
 }catch{message.error('实时任务状态读取失败');}
}
async function loadDetail(id:string){const epoch=++request;const data=(await api.get(`/live-runs/${id}`)).data;if(epoch!==request)return;detail.value=data;
 if(!data.watches.some((w:any)=>`${w.chain}:${w.ca}:${w.pair_id}`===selectedWatch.value)){
  const w=data.watches.find((x:any)=>x.state_json?.position)||data.watches[0];selectedWatch.value=w?`${w.chain}:${w.ca}:${w.pair_id}`:undefined;
 }
}
async function checkPassword(){
 if(!secureAdminContext)return message.error('当前页面不是 HTTPS，禁止发送管理员口令');
 if(!password.value)return message.warning('请输入实盘管理员口令');
 try{await api.post('/live-admin/check',{}, {headers:adminHeader()});authorized.value=true;message.success('管理员身份已验证，本页离开后口令自动清除');}
 catch(e:any){authorized.value=false;message.error(e.response?.data?.message??'验证失败；生产环境需通过 HTTPS 访问');}
}
async function create(){
 if(!versionId.value)return message.warning('请选择不可变策略版本');
 if(real&&!authorized.value)return message.warning('先验证管理员口令');
 busy.value=true;
 try{
  const body:any={name:form.value.name.trim()||`${real?'实盘':'模拟盘'} · ${form.value.chain.toUpperCase()}`,mode:props.mode,chain:form.value.chain,interval:form.value.interval,valueType:form.value.valueType,strategyVersionId:versionId.value,initialCapital:Number(form.value.initialCapital)};
  if(real){body.walletAddress=form.value.walletAddress.trim();body.risk={maxOrderNative:Number(form.value.maxOrderNative),maxTotalNative:Number(form.value.maxTotalNative),maxDailyLossUsd:Number(form.value.maxDailyLossUsd),maxPositions:Number(form.value.maxPositions),tip:Number(form.value.tip),slippagePercent:Number(form.value.slippagePercent)};}
  const created=(await api.post('/live-runs',body,{headers:adminHeader()})).data;
  message.success('任务已创建，默认暂停；检查配置后手动启动');await refresh();selectedRunId.value=created.id;await loadDetail(created.id);
 }catch(e:any){message.error(e.response?.data?.message??'创建失败');}finally{busy.value=false;}
}
async function action(id:string,operation:'start'|'pause'|'stop'){
 if(real&&!authorized.value)return message.warning('先验证管理员口令');
 if(operation==='stop'){
  const ok=await new Promise<boolean>(resolve=>Modal.confirm({title:'停止实时任务？',content:'停止后不再接收新信号或产生新订单；已有实盘持仓不会自动平仓。',okText:'确认停止',cancelText:'返回',onOk:()=>resolve(true),onCancel:()=>resolve(false)}));
  if(!ok)return;
 }
 busy.value=true;try{await api.post(`/live-runs/${id}/${operation}`,{}, {headers:adminHeader()});await refresh();message.success('任务状态已更新');}
 catch(e:any){message.error(e.response?.data?.message??'操作失败');}finally{busy.value=false;}
}
async function emergency(){
 if(!authorized.value)return message.warning('先验证管理员口令');
 busy.value=true;try{const result=(await api.post('/live-runs/emergency-stop',{}, {headers:adminHeader()})).data;message.warning(`已暂停 ${result.stopped.length} 个实盘任务；已提交订单及持仓仍需核对`);await refresh();}
 catch(e:any){message.error(e.response?.data?.message??'紧急停止失败');}finally{busy.value=false;}
}
watch(templateId,()=>void loadVersions().catch(()=>message.error('策略版本加载失败')));
watch(selectedRunId,id=>{detail.value=undefined;selectedWatch.value=undefined;if(id)void loadDetail(id).catch(()=>message.error('任务详情加载失败'));});
onMounted(async()=>{try{templates.value=(await api.get('/strategy-templates')).data.filter((t:any)=>t.status==='active');templateId.value=templates.value[0]?.id;await refresh();timer=window.setInterval(()=>void refresh(),5000);}catch{message.error('实时工作台初始化失败');}});
onBeforeUnmount(()=>{window.clearInterval(timer);password.value='';authorized.value=false;request++;});
</script>

<template>
<div class="live-workspace">
 <a-alert v-if="real" type="warning" show-icon class="live-notice" message="实盘默认禁止真实下单" description="需在服务器单独启用、配置 XXYY API Key、可信行情订阅和 HTTPS；当前仅支持 SOL/BSC。ROBIN 暂只可在模拟盘运行。订单与实际持仓未核对时会暂停。" />
 <a-alert v-else type="info" show-icon class="live-notice" message="模拟盘使用实时成交，不会连接交易钱包" description="只接收任务启动后的新信号；策略在 30s/1m K 线收盘后决策，模拟成交取决策后的下一笔有效交易。" />
 <section v-if="real" class="live-auth" aria-label="实盘管理员验证"><div><strong>实盘管理员</strong><p>{{secureAdminContext?'口令只保留在当前页面内存中，不保存到浏览器或数据库。':'当前访问不是 HTTPS，仅提供脱敏只读视图；请先配置 HTTPS。'}}</p></div><a-input-password v-model:value="password" :disabled="!secureAdminContext" autocomplete="off" placeholder="管理员口令" aria-label="实盘管理员口令" @press-enter="checkPassword" /><a-button :type="authorized?'default':'primary'" :disabled="!secureAdminContext" @click="checkPassword">{{ authorized?'已验证 · 重新验证':'验证口令' }}</a-button><a-button danger :disabled="!authorized||busy" @click="emergency">紧急停止全部实盘任务</a-button></section>
 <div class="live-layout">
  <section class="live-create" aria-label="创建实时任务"><div class="live-section-head"><h2>新建{{real?'实盘':'模拟盘'}}任务</h2><span>创建后默认暂停</span></div>
   <a-form layout="vertical" @finish="create">
    <a-form-item label="任务名称"><a-input v-model:value="form.name" :placeholder="`${real?'实盘':'模拟盘'} · ${form.chain.toUpperCase()}`" /></a-form-item>
    <a-form-item label="策略模板"><a-select v-model:value="templateId" :options="templates.map(t=>({label:t.name,value:t.id}))" placeholder="选择策略模板" /></a-form-item>
    <a-form-item label="不可变版本"><a-select v-model:value="versionId" :options="versions.map(v=>({label:`v${v.version}`,value:v.id}))" placeholder="选择版本" /></a-form-item>
    <div class="live-form-row"><a-form-item label="链"><a-select v-model:value="form.chain" :options="(real?['sol','bsc']:['sol','bsc','robin']).map(x=>({label:x.toUpperCase(),value:x}))" /></a-form-item><a-form-item label="周期"><a-select v-model:value="form.interval" :options="[{label:'30s',value:'30s'},{label:'1m',value:'1m'}]" /></a-form-item></div>
    <div class="live-form-row"><a-form-item label="判断维度"><a-select v-model:value="form.valueType" :options="[{label:'市值',value:'mcap'},{label:'价格',value:'price'}]" /></a-form-item><a-form-item :label="real?'额度基准（USD）':'初始资金（USD）'"><a-input-number v-model:value="form.initialCapital" :min="1" :precision="2" /></a-form-item></div>
    <template v-if="real"><a-form-item label="专用 XXYY 钱包地址"><a-input v-model:value="form.walletAddress" placeholder="每条链、每个策略实例使用独立钱包" autocomplete="off" /></a-form-item>
     <div class="live-form-row"><a-form-item label="单笔上限（原生币）"><a-input-number v-model:value="form.maxOrderNative" :min="0.000001" :precision="6" /></a-form-item><a-form-item label="总敞口上限（原生币）"><a-input-number v-model:value="form.maxTotalNative" :min="0.000001" :precision="6" /></a-form-item></div>
     <div class="live-form-row"><a-form-item label="日亏损上限（USD）"><a-input-number v-model:value="form.maxDailyLossUsd" :min="0.01" :precision="2" /></a-form-item><a-form-item label="最大持仓数"><a-input-number v-model:value="form.maxPositions" :min="1" :precision="0" /></a-form-item></div>
     <div class="live-form-row"><a-form-item :label="form.chain==='sol'?'优先费（SOL）':'优先费（Gwei）'"><a-input-number v-model:value="form.tip" :min="0.000001" :precision="6" /></a-form-item><a-form-item label="滑点上限 %"><a-input-number v-model:value="form.slippagePercent" :min="0.01" :max="100" :precision="2" /></a-form-item></div>
    </template>
    <a-button type="primary" html-type="submit" block :loading="busy" :disabled="!versionId||(real&&!authorized)">创建暂停任务</a-button>
   </a-form>
  </section>
  <section class="live-history" aria-label="实时任务列表"><div class="live-section-head"><h2>{{real?'实盘':'模拟盘'}}任务</h2><a-button size="small" :loading="loading" @click="refresh">刷新</a-button></div>
   <a-empty v-if="!runs.length" description="还没有任务。先选择策略版本，创建后再启动监控。" />
   <div v-else class="live-run-list"><button v-for="r in runs" :key="r.id" class="live-run-row" :class="{selected:selectedRunId===r.id}" @click="selectedRunId=r.id"><span><strong>{{r.name}}</strong><small>{{r.chain.toUpperCase()}} · {{r.interval}} · {{r.value_type==='mcap'?'市值':'价格'}} · {{beijingTime(r.created_at)}}</small></span><a-tag :color="statusColor(r.status)">{{statusText(r.status)}}</a-tag></button></div>
  </section>
 </div>
 <section v-if="detail" class="live-detail" aria-label="实时任务详情"><div class="live-section-head"><div><h2>{{detail.run.name}}</h2><p>{{detail.run.chain.toUpperCase()}} · {{detail.run.interval}} · {{detail.run.value_type==='mcap'?'市值':'价格'}} · 仅新信号</p></div><a-tag :color="statusColor(detail.run.status)">{{statusText(detail.run.status)}}</a-tag></div>
  <a-alert v-if="detail.run.error_message" type="warning" show-icon :message="detail.run.error_message" class="live-notice" />
  <div class="live-summary"><span>已监控项目 <strong>{{detail.watches.length}}</strong></span><span>模拟现金／额度基准 <strong>{{formatNumber(detail.run.cash)}}</strong></span><span>已实现盈亏 <strong :class="valueTone(detail.run.realized_pnl)">{{signedValue(detail.run.realized_pnl)}}</strong></span><span>最近心跳 <strong>{{beijingTime(detail.run.heartbeat_at)}}</strong></span></div>
  <div class="live-actions"><a-button type="primary" :disabled="busy||detail.run.status==='running'||detail.run.status==='stopped'||(real&&!authorized)" @click="action(detail.run.id,'start')">启动</a-button><a-button :disabled="busy||detail.run.status!=='running'||(real&&!authorized)" @click="action(detail.run.id,'pause')">暂停</a-button><a-button danger :disabled="busy||detail.run.status==='stopped'||(real&&!authorized)" @click="action(detail.run.id,'stop')">停止</a-button><span v-if="real">停止不代表平仓；已提交订单与钱包仓位必须单独核对。</span></div>
  <a-divider orientation="left">监控项目与成交</a-divider>
  <a-empty v-if="!detail.watches.length" description="等待符合来源与链筛选的新信号；历史信号不会追加入场。" />
  <template v-else><div class="live-watch-picker"><label for="live-watch">项目 / 主池</label><a-select id="live-watch" v-model:value="selectedWatch" show-search option-filter-prop="label" :options="detail.watches.map((w:any)=>({value:`${w.chain}:${w.ca}:${w.pair_id}`,label:`${w.chain.toUpperCase()} · ${w.ca} · ${w.pair_id}`}))" /><a-button @click="chartEpoch++">刷新 K 线</a-button></div>
   <p v-if="chosenWatch" class="live-context">首次监控 {{beijingTime(chosenWatch.signal_time,true)}} · {{chosenWatch.signal_source}} · {{chosenWatch.status}}</p>
   <TradingViewChart v-if="chartSymbol" :key="`${chartSymbol}:${chartEpoch}`" :symbol="chartSymbol" :interval="detail.run.interval" :live-run-id="detail.run.id" />
  </template>
  <a-divider orientation="left">订单与成交</a-divider>
  <a-table :columns="columns" :data-source="detail.orders" row-key="id" size="small" :scroll="{x:980}" :pagination="{pageSize:20}" :locale="{emptyText:'尚无买卖决策或成交'}"><template #bodyCell="{column,record}"><template v-if="column.key==='created_at'">{{beijingTime(record.created_at)}}</template><template v-else-if="column.key==='ca'"><span class="live-address">{{record.ca}}</span><small class="live-pair">{{record.pair_id}}</small></template><template v-else-if="column.key==='side'">{{record.side==='buy'?'买入':'卖出'}}</template><template v-else-if="column.key==='fill_price'">{{record.fill_price==null?'—':preciseValue(record.fill_price)}}</template><template v-else-if="column.key==='quantity'">{{record.quantity==null?'—':preciseValue(record.quantity)}}</template></template></a-table>
  <a-divider orientation="left">运行事件</a-divider><a-empty v-if="!detail.events.length" description="暂无运行事件" /><ol v-else class="live-event-list"><li v-for="(e,i) in detail.events" :key="i"><time>{{beijingTime(e.event_time,true)}}</time><strong>{{e.kind}}</strong><span>{{e.ca||'系统'}} · {{e.payload?.reason||e.payload?.source||''}}</span></li></ol>
 </section>
</div>
</template>

<style scoped>
.live-workspace{display:grid;gap:18px}.live-notice{margin-bottom:2px}.live-auth,.live-create,.live-history,.live-detail{background:#fff;border:1px solid #dfe6e3;border-radius:10px;padding:18px}.live-auth{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.live-auth>div{flex:1;min-width:240px}.live-auth strong{font-size:15px}.live-auth p,.live-section-head p{margin:3px 0 0;color:#53615d;font-size:12px}.live-auth .ant-input-password{width:min(280px,100%)}.live-layout{display:grid;grid-template-columns:minmax(290px,390px) minmax(0,1fr);gap:18px;align-items:start}.live-section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}.live-section-head h2{font-size:16px;margin:0}.live-section-head>span{font-size:12px;color:#53615d}.live-form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.live-form-row>.ant-form-item{min-width:0}.live-create :deep(.ant-input-number){width:100%}.live-run-list{max-height:420px;overflow:auto}.live-run-row{width:100%;display:flex;justify-content:space-between;gap:14px;align-items:flex-start;padding:12px 8px;background:transparent;border:0;border-bottom:1px solid #e8eeeb;text-align:left;cursor:pointer}.live-run-row:hover,.live-run-row.selected{background:#f1f7f4}.live-run-row:focus-visible{outline:2px solid #176b5b}.live-run-row>span{min-width:0}.live-run-row strong,.live-run-row small{display:block}.live-run-row strong{overflow-wrap:anywhere}.live-run-row small{color:#53615d;margin-top:4px}.live-summary{display:flex;flex-wrap:wrap;gap:8px 24px;padding:13px 0;border-block:1px solid #e8eeeb}.live-summary span{font-size:12px;color:#53615d}.live-summary strong{display:block;font-size:15px;color:#18211f;font-variant-numeric:tabular-nums}.live-summary strong.value-positive{color:#2f7d5b}.live-summary strong.value-negative{color:#c2413b}.live-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:15px}.live-actions span,.live-context{font-size:12px;color:#53615d}.live-watch-picker{display:flex;align-items:center;gap:10px}.live-watch-picker label{white-space:nowrap;font-size:13px}.live-watch-picker .ant-select{flex:1;min-width:0}.live-context{margin:10px 0}.live-address{display:block;max-width:260px;overflow-wrap:anywhere}.live-pair{color:#53615d;overflow-wrap:anywhere}.live-event-list{padding:0;margin:0;list-style:none;max-height:240px;overflow:auto}.live-event-list li{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #e8eeeb;font-size:12px}.live-event-list time{color:#53615d;white-space:nowrap}.live-event-list strong{min-width:100px}
@media(max-width:900px){.live-layout{grid-template-columns:1fr}.live-run-list{max-height:270px}}@media(max-width:680px){.live-auth,.live-create,.live-history,.live-detail{padding:14px}.live-auth .ant-input-password{width:100%}.live-form-row{grid-template-columns:1fr;gap:0}.live-watch-picker{align-items:stretch;flex-wrap:wrap}.live-watch-picker label{width:100%}.live-watch-picker .ant-select{flex-basis:100%}.live-event-list li{flex-wrap:wrap}.live-event-list li span{width:100%}}
</style>
