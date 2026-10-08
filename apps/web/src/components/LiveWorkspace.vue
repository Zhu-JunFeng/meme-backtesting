<script setup lang="ts">
import {computed,h,nextTick,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {message,Modal} from 'ant-design-vue';
import {api} from '../api';
import {beijingTime} from '../time';
import {eventLabels,formatNumber,signedValue,valueTone} from '../format';
import TradingViewChart from './TradingViewChart.vue';
import LivePortfolio from './LivePortfolio.vue';
import {liveSignalSources} from '@meme/domain';
import {signalSourceOptions as signalSources,sourceText as signalSourceText,runSourceText,monitoringRows} from '../live-monitor';
import ProjectIdentity from './ProjectIdentity.vue';
import {provideProjectDirectory} from '../composables/useProjectDirectory';
import {shortCa} from '../project-identity';
const projectDirectory=provideProjectDirectory();

const props=defineProps<{mode:'paper'|'live'}>();
const templates=ref<any[]>([]),versions=ref<any[]>([]),runs=ref<any[]>([]),detail=ref<any>();
const templateId=ref<string>(),versionId=ref<string>(),selectedRunId=ref<string>(),selectedWatch=ref<string>();
const password=ref(''),authorized=ref(false),loading=ref(false),busy=ref(false),chartEpoch=ref(0),chartAnchor=ref<any>(),locating=ref(false);
const detailElement=ref<HTMLElement|null>(null);
const chartElement=ref<HTMLElement|null>(null);
const form=ref({name:'',chain:'sol',signalSources:['fomo_new_project_expanded'],interval:'30s',valueType:'mcap',initialCapital:1000,walletAddress:'',maxOrderNative:0.01,maxTotalNative:0.05,maxDailyLossUsd:20,maxPositions:1,tip:0.001,slippagePercent:5});
const editingSources=ref(false),sourceSelection=ref<string[]>([]),watchSearch=ref(''),watchSource=ref<string>(),watchSort=ref<'asc'|'desc'>('desc'),watchPage=ref(1);
const monitored=computed(()=>monitoringRows(detail.value?.watches??[],watchSearch.value,watchSource.value,watchSort.value));
watch([watchSearch,watchSource,watchSort],()=>watchPage.value=1);
watch(()=>monitored.value.length,()=>{watchPage.value=Math.min(watchPage.value,Math.max(1,Math.ceil(monitored.value.length/10)));});
function editSources(){sourceSelection.value=[...(detail.value.run.signalSources??liveSignalSources(detail.value.run.signal_source))];editingSources.value=true;}
async function saveSources(){
 if(!sourceSelection.value.length)return message.warning('至少选择一个信号来源');
 if(real&&!authorized.value)return message.warning('先验证管理员口令');
 const id=detail.value.run.id;busy.value=true;
 try{await api.patch(`/live-runs/${id}/signal-sources`,{signalSources:sourceSelection.value},{headers:adminHeader()});if(id===selectedRunId.value)editingSources.value=false;await refresh();message.success('信号来源已更新，仅影响后续新 CA；现有监控和持仓不变');}
 catch(e:any){message.error(e.response?.data?.message??'保存信号来源失败');}finally{busy.value=false;}
}
const runFilter=ref<'all'|'running'|'paused'|'stopped'>('all');
const runCounts=ref({all:0,running:0,paused:0,stopped:0}),runPage=ref(1),runTotal=ref(0),runLoaded=ref(false);
const runPageSize=12;
const secureAdminContext=window.location.protocol==='https:'||['localhost','127.0.0.1'].includes(window.location.hostname);
const chosenWatch=computed(()=>detail.value?.watches?.find((w:any)=>`${w.chain}:${w.ca}:${w.pair_id}`===selectedWatch.value));
const chartSymbol=computed(()=>selectedWatch.value&&detail.value?`${selectedWatch.value}:${detail.value.run.value_type}`:'');
function projectOption(chain:string,ca:string,pair:string,historical=false){return {value:`${chain}:${ca}:${pair}`,label:h('span',{class:'live-project-option'},[h(ProjectIdentity,{chain,ca,compact:true}),h('small',`池 ${shortCa(pair)}${historical?'（历史）':''}`)])};}
const watchOptions=computed(()=>{const options=(detail.value?.watches??[]).map((w:any)=>projectOption(w.chain,w.ca,w.pair_id));for(const pair of chartAnchor.value?.pairIds??[]){const [chain,ca]=String(chartAnchor.value.symbol).split(':');const value=`${chain}:${ca}:${pair}`;if(!options.some((o:any)=>o.value===value))options.push(projectOption(chain,ca,pair,true));}return options;});
const filterWatchOption=(input:string,option:any)=>String(option.value).toLowerCase().includes(input.toLowerCase());
const real=props.mode==='live';let timer:number|undefined,request=0,locateRequest=0,overviewRequest=0;
function statusText(s:string){return ({paused:'已暂停',running:'运行中',stopped:'已停止'} as Record<string,string>)[s]??s;}
function statusColor(s:string){return ({paused:'default',running:'green',stopped:'default'} as Record<string,string>)[s]??'default';}
function feedText(s:string){return ({connecting:'连接中',recovering:'补行情',connected:'行情正常',paused:'已暂停'} as Record<string,string>)[s]??'连接中';}
function watchText(s:string){return ({monitoring:'监控中',recovering:'补行情中',pending_eviction:'等待平仓后移除',evicted:'已移除',paused:'已暂停'} as Record<string,string>)[s]??'状态未识别';}
function eventText(s:string){return ({external_signal:'外部信号',decision:'买卖决策',fill:'成交',execution_switched:'执行口径切换',order_rejected:'订单被拒绝',feed_disconnect:'行情断开',feed_reconnected:'行情已重连',late_trade:'乱序成交',eviction:'退出监控'} as Record<string,string>)[s]??'运行事件';}
function eventReason(payload:any){const reason=payload?.reason;return reason?eventLabels[reason]??(typeof reason==='string'&&reason.includes('_')?'原因未识别':reason):signalSourceText(payload?.source);}
function adminHeader(){return real?{'x-live-admin-password':password.value}:{};}
async function loadVersions(){if(!templateId.value)return;versions.value=(await api.get(`/strategy-templates/${templateId.value}/versions`)).data;versionId.value=templates.value.find(t=>t.id===templateId.value)?.currentVersionId??versions.value[0]?.id;}
async function refresh(){
 const epoch=++overviewRequest;loading.value=true;
 try{const overview=(await api.get('/live-runs/overview',{params:{mode:props.mode,status:runFilter.value,page:runPage.value,pageSize:runPageSize}})).data;
  if(epoch!==overviewRequest)return;
  runs.value=overview.items;runCounts.value=overview.counts;runTotal.value=overview.total;runLoaded.value=true;
  if(runPage.value>1&&!overview.items.length&&overview.total){runPage.value=Math.max(1,Math.ceil(overview.total/runPageSize));return;}
  if(selectedRunId.value)await loadDetail(selectedRunId.value);
 }catch{if(epoch===overviewRequest)message.error('实时策略概览读取失败');}finally{if(epoch===overviewRequest)loading.value=false;}
}
function setRunFilter(value:'all'|'running'|'paused'|'stopped'){if(runFilter.value===value)return;runFilter.value=value;runPage.value=1;void refresh();}
function setRunPage(value:number){runPage.value=value;void refresh();}
async function loadDetail(id:string){const epoch=++request;const data=(await api.get(`/live-runs/${id}`)).data;if(epoch!==request)return;detail.value=data;
 if(!data.watches.some((w:any)=>`${w.chain}:${w.ca}:${w.pair_id}`===selectedWatch.value)&&!chartAnchor.value?.pairIds?.includes(selectedWatch.value?.split(':').slice(2).join(':'))){
  const w=data.watches.find((x:any)=>x.state_json?.position)||data.watches[0];selectedWatch.value=w?`${w.chain}:${w.ca}:${w.pair_id}`:undefined;
 }
}
async function locate(kind:'positionId'|'orderId',id:string,pairId?:string){const epoch=++locateRequest;locating.value=true;try{const data=(await api.get(`/live-runs/${detail.value.run.id}/locate`,{params:{[kind]:id,...(pairId?{pairId}:{})}})).data;if(epoch!==locateRequest)return;chartAnchor.value=data;selectedWatch.value=data.symbol.slice(0,data.symbol.lastIndexOf(':'));await nextTick();chartElement.value?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}catch(e:any){if(epoch===locateRequest)message.error(e.response?.data?.message??'点位定位失败');}finally{if(epoch===locateRequest)locating.value=false;}}
async function selectPair(value:string){selectedWatch.value=value;if(chartAnchor.value){const [chain,ca,...rest]=value.split(':'),pairId=rest.join(':'),[anchorChain,anchorCa]=String(chartAnchor.value.symbol).split(':');if(chain!==anchorChain||ca!==anchorCa||!chartAnchor.value.pairIds.includes(pairId)){locateRequest++;chartAnchor.value=undefined;return;}const id=chartAnchor.value.positionId,order=chartAnchor.value.orderId;await locate(id?'positionId':'orderId',id??order,pairId);}}
async function checkPassword(){
 if(!secureAdminContext)return message.error('当前页面不是 HTTPS，禁止发送管理员口令');
 if(!password.value)return message.warning('请输入实盘管理员口令');
 try{await api.post('/live-admin/check',{}, {headers:adminHeader()});authorized.value=true;message.success('管理员身份已验证，本页离开后口令自动清除');}
 catch(e:any){authorized.value=false;message.error(e.response?.data?.message??'验证失败；生产环境需通过 HTTPS 访问');}
}
async function create(){
 if(!form.value.signalSources.length)return message.warning('至少选择一个信号来源');
 if(!versionId.value)return message.warning('请选择不可变策略版本');
 if(real&&!authorized.value)return message.warning('先验证管理员口令');
 busy.value=true;
 try{
  const body:any={name:form.value.name.trim()||`${real?'实盘':'模拟盘'} · ${form.value.chain.toUpperCase()}`,mode:props.mode,chain:form.value.chain,signalSources:form.value.signalSources,interval:form.value.interval,valueType:form.value.valueType,strategyVersionId:versionId.value,initialCapital:Number(form.value.initialCapital)};
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
watch(selectedRunId,async id=>{
 projectDirectory.clear();
 request++;editingSources.value=false;watchSearch.value='';watchSource.value=undefined;watchPage.value=1;
 locateRequest++;chartAnchor.value=undefined;detail.value=undefined;selectedWatch.value=undefined;
 if(!id)return;
 try{
  await loadDetail(id);
  await nextTick();
  if(id===selectedRunId.value&&window.matchMedia('(max-width: 900px)').matches)
   detailElement.value?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
 }catch{message.error('任务详情加载失败');}
});
onMounted(async()=>{try{templates.value=(await api.get('/strategy-templates')).data.filter((t:any)=>t.status==='active');templateId.value=templates.value[0]?.id;await refresh();timer=window.setInterval(()=>void refresh(),5000);}catch{message.error('实时工作台初始化失败');}});
onBeforeUnmount(()=>{window.clearInterval(timer);password.value='';authorized.value=false;request++;locateRequest++;overviewRequest++;});
</script>

<template>
<div class="live-workspace">
 <a-alert v-if="real" type="warning" show-icon class="live-notice" message="实盘默认禁止真实下单" description="需在服务器单独启用、配置 XXYY API Key、可信行情订阅和 HTTPS；当前仅支持 SOL/BSC。订单结果未核实时任务仍运行，但冻结新订单，绝不盲目重发。" />
 <a-alert v-else type="info" show-icon class="live-notice" message="模拟盘按收盘 K 线撮合，不会连接交易钱包" description="仅接收指定来源、启动后的新信号。收盘后按回测规则判断：买入按收盘值，止损／止盈按触线值或跳空开盘值模拟成交；不等待下一笔交易。实盘成交价可能不同，历史收益不代表未来收益。" />
 <section v-if="real" class="live-auth" aria-label="实盘管理员验证"><div><strong>实盘管理员</strong><p>{{secureAdminContext?'口令只保留在当前页面内存中，不保存到浏览器或数据库。':'当前访问不是 HTTPS，仅提供脱敏只读视图；请先配置 HTTPS。'}}</p></div><a-input-password v-model:value="password" :disabled="!secureAdminContext" autocomplete="off" placeholder="管理员口令" aria-label="实盘管理员口令" @press-enter="checkPassword" /><a-button :type="authorized?'default':'primary'" :disabled="!secureAdminContext" @click="checkPassword">{{ authorized?'已验证 · 重新验证':'验证口令' }}</a-button><a-button danger :disabled="!authorized||busy" @click="emergency">紧急停止全部实盘任务</a-button></section>
 <div class="live-layout">
  <section class="live-create" aria-label="创建实时任务"><div class="live-section-head"><h2>新建{{real?'实盘':'模拟盘'}}任务</h2><span>创建后默认暂停</span></div>
   <a-form layout="vertical" @finish="create">
    <a-form-item label="任务名称"><a-input v-model:value="form.name" :placeholder="`${real?'实盘':'模拟盘'} · ${form.chain.toUpperCase()}`" /></a-form-item>
    <a-form-item label="策略模板"><a-select v-model:value="templateId" :options="templates.map(t=>({label:t.name,value:t.id}))" placeholder="选择策略模板" /></a-form-item>
    <a-form-item label="不可变版本"><a-select v-model:value="versionId" :options="versions.map(v=>({label:`v${v.version}`,value:v.id}))" placeholder="选择版本" /></a-form-item>
    <a-form-item label="外部信号来源（多选）" extra="至少选择一项；任一所选来源触发均可纳入，仍需通过准入和预热。不追收启动前的信号。"><a-select v-model:value="form.signalSources" mode="multiple" :options="signalSources" placeholder="选择接入的信号" aria-label="外部信号来源（多选）" /></a-form-item>
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
  <section class="live-history" aria-label="实时策略运行概览"><div class="live-section-head"><div><h2>{{real?'实盘':'模拟盘'}}策略运行概览</h2><p>无需打开详情即可查看监控规模与已平仓表现 · 每 5 秒更新</p></div><a-button size="small" :loading="loading" @click="refresh">刷新</a-button></div>
   <div class="live-run-filters" role="group" aria-label="按任务状态筛选"><a-button size="small" :type="runFilter==='all'?'primary':'default'" :aria-pressed="runFilter==='all'" @click="setRunFilter('all')">全部 {{runCounts.all}}</a-button><a-button size="small" :type="runFilter==='running'?'primary':'default'" :aria-pressed="runFilter==='running'" @click="setRunFilter('running')">运行中 {{runCounts.running}}</a-button><a-button size="small" :type="runFilter==='paused'?'primary':'default'" :aria-pressed="runFilter==='paused'" @click="setRunFilter('paused')">已暂停 {{runCounts.paused}}</a-button><a-button size="small" :type="runFilter==='stopped'?'primary':'default'" :aria-pressed="runFilter==='stopped'" @click="setRunFilter('stopped')">已停止 {{runCounts.stopped}}</a-button></div>
   <a-skeleton v-if="!runLoaded&&loading" active :paragraph="{rows:5}" />
   <a-empty v-else-if="runLoaded&&!runCounts.all" description="还没有任务。先选择策略版本，创建后再启动监控。" />
   <a-empty v-else-if="runLoaded&&!runs.length" description="当前状态下没有策略任务，可切换上方状态查看。" />
   <div v-else class="live-run-list" :aria-busy="loading"><button v-for="r in runs" :key="r.id" class="live-run-row" :class="{selected:selectedRunId===r.id}" :aria-pressed="selectedRunId===r.id" @click="selectedRunId=r.id"><span class="live-run-top"><strong>{{r.name}}</strong><a-tag :color="statusColor(r.status)">{{statusText(r.status)}}</a-tag></span><small class="live-run-meta">{{r.chain.toUpperCase()}} · {{r.interval}} · {{r.value_type==='mcap'?'市值':'价格'}} · {{runSourceText(r)}}</small><span class="live-run-metrics"><span><small>{{r.status==='stopped'?'保留监控 CA':'监控 CA'}}</small><strong>{{Number(r.active_ca_count||0)}} / 20</strong></span><span><small>当前 / 已平仓</small><strong>{{r.performance?.openCount??'—'}} / {{r.performance?.closedCount??'—'}}</strong></span><span><small>已平仓胜率</small><strong>{{r.performance?.winRate==null?'—':formatNumber(r.performance.winRate)+'%'}}</strong></span><span><small>已平仓净盈亏</small><strong :class="valueTone(r.performance?.realizedPnl)">{{r.performance?signedValue(r.performance.realizedPnl)+' USD':'—'}}</strong></span><span><small>估算浮盈亏</small><strong :class="valueTone(r.performance?.unrealizedPnl)">{{r.performance?.unrealizedPnl==null?'不可用':signedValue(r.performance.unrealizedPnl)+' USD'}}</strong></span></span><span class="live-run-foot"><span>{{r.status==='running'?feedText(r.feed_state):'最近更新'}} · {{beijingTime(r.status==='running'?r.heartbeat_at:r.updated_at)}}</span><span v-if="r.error_message||r.execution_hold_reason" class="live-run-warning">{{r.execution_hold_reason?'订单核验中':'有运行提示'}}</span><span class="live-run-open">查看详情 →</span></span></button></div>
   <a-pagination v-if="runTotal>runPageSize" class="live-run-pagination" :current="runPage" :page-size="runPageSize" :total="runTotal" :show-size-changer="false" :show-total="(n:number)=>`共 ${n} 个策略任务`" @change="setRunPage" />
  </section>
 </div>
 <section v-if="detail" ref="detailElement" class="live-detail" aria-label="实时任务详情"><div class="live-section-head"><div><h2>{{detail.run.name}}</h2><p>{{detail.run.chain.toUpperCase()}} · {{detail.run.interval}} · {{detail.run.value_type==='mcap'?'市值':'价格'}} · {{runSourceText(detail.run)}} · 仅新信号</p></div><a-tag :color="statusColor(detail.run.status)">{{statusText(detail.run.status)}}</a-tag></div>
  <div class="live-source-editor"><template v-if="editingSources"><a-select v-model:value="sourceSelection" mode="multiple" :options="signalSources" :disabled="busy" aria-label="修改任务信号来源" /><a-button type="primary" :loading="busy" :disabled="!sourceSelection.length" @click="saveSources">保存来源</a-button><a-button :disabled="busy" @click="editingSources=false">取消</a-button><p>仅影响后续新 CA 准入；现有监控 CA 和持仓继续管理，不补发历史买卖。</p></template><a-button v-else :disabled="busy||detail.run.status==='stopped'||(real&&!authorized)" @click="editSources">修改接入信号</a-button></div>
  <p class="live-context" v-if="detail.run.execution_version==='closed-bar-v2'">执行口径：完整 K 线收盘后判断；止损／止盈检查整根高低值，模拟按回测阈值或跳空开盘值撮合，实盘以真实成交为准。正常无成交时补平价 K 线，断线补数不追单。切换时间：{{beijingTime(detail.run.execution_switched_at)}}（北京时间）。此前成交不重算。</p>
  <p class="live-context" v-else>执行口径：旧版逐笔退出。任务切换后将在此显示生效时间，历史成交保持原样。</p>
  <a-alert v-if="detail.run.market_source==='meme_market_v2'" type="warning" show-icon message="Meme Market 协议 2 · 尽力投递，不保证成交完整" description="健康连接下的零量平线为推定无成交。断线、已知缺口或预热未完成时暂停策略交易；已有持仓的止损可能无法及时执行。历史补数仍使用 XXYY，不追补历史订单。" />
  <p class="live-context" v-if="detail.run.market_status">市值优先使用成交原值，缺失时按同笔美元价格 × 缓存实际供应量计算。供应量已就绪 {{detail.run.market_status.supplyReady ?? 0}} 个 · 缓存 {{detail.run.market_status.cache==='redis'?'Redis + 内存':'进程内存'}} · 接收市值原值 {{detail.run.market_status.quality?.wsMcap ?? 0}} 次 / 计算补齐 {{detail.run.market_status.quality?.derivedMcap ?? 0}} 次。</p>
  <p class="live-context" v-if="detail.run.market_status">行情订阅 {{detail.run.market_status.subscribed}} 个 · 策略就绪 {{detail.run.market_status.ready}} 个 · 最近消息 {{beijingTime(detail.run.market_status.lastMessageAt)}} · 来源切换 {{beijingTime(detail.run.market_switched_at)}}（北京时间）。当前 Worker 全局质量计数：非法成交 {{detail.run.market_status.quality?.invalid ?? 0}} / 中断或缺口 {{detail.run.market_status.quality?.gaps ?? 0}} / 溢出 {{detail.run.market_status.quality?.overflow ?? 0}}。心跳与消息到达不代表行情完整。</p>
  <a-alert v-if="detail.run.error_message" type="warning" show-icon :message="detail.run.error_message" class="live-notice" />
  <a-alert v-if="detail.run.execution_hold_reason" type="warning" show-icon :message="`订单核验中：${detail.run.execution_hold_reason}`" description="任务保持运行，但所有新订单已冻结；未知订单不会自动重发。" class="live-notice" />
  <div class="live-summary"><span>活动 CA <strong>{{detail.run.active_ca_count}} / 20</strong></span><span>行情状态 <strong>{{feedText(detail.run.feed_state)}}</strong></span><span>模拟现金／额度基准 <strong>{{formatNumber(detail.run.cash)}}</strong></span><span>已实现盈亏 <strong :class="valueTone(detail.run.realized_pnl)">{{signedValue(detail.run.realized_pnl)}}</strong></span><span>最近心跳 <strong>{{beijingTime(detail.run.heartbeat_at)}}</strong></span><span>最近信号 <strong>{{beijingTime(detail.run.last_signal_at,true)}}</strong></span><span>最近成交 <strong>{{beijingTime(detail.run.last_trade_at,true)}}</strong></span><span>重连 / 乱序 / 丢弃 <strong>{{detail.run.reconnect_count}} / {{detail.run.late_trade_count}} / {{detail.run.dropped_trade_count}}</strong></span></div>
  <p v-if="detail.run.feed_reason" class="live-context">行情提示：{{detail.run.feed_reason}}</p>
  <div class="live-actions"><a-button type="primary" :disabled="busy||detail.run.status==='running'||detail.run.status==='stopped'||(real&&!authorized)" @click="action(detail.run.id,'start')">启动</a-button><a-button :disabled="busy||detail.run.status!=='running'||(real&&!authorized)" @click="action(detail.run.id,'pause')">暂停</a-button><a-button danger :disabled="busy||detail.run.status==='stopped'||(real&&!authorized)" @click="action(detail.run.id,'stop')">停止</a-button><span v-if="real">停止不代表平仓；已提交订单与钱包仓位必须单独核对。</span></div>
  <a-divider orientation="left">监控项目与成交</a-divider>
  <section aria-label="正在监控的 CA" class="live-monitor-list">
   <div class="live-section-head"><h2>正在监控的 CA · {{detail.run.active_ca_count}}</h2><span>每 5 秒刷新 · 北京时间 UTC+8</span></div>
   <p class="live-context">包含补行情和等待平仓后移除的项目；暂停任务保留名单但不执行策略。监控时间为首次加入本任务的时间，不是信号触发时间。来源为入组信号，修改任务来源不改写已有 CA 的来源。</p>
   <div class="live-monitor-tools"><a-input v-model:value="watchSearch" allow-clear placeholder="搜索 CA / 交易池" aria-label="搜索监控 CA" /><a-select v-model:value="watchSource" allow-clear :options="signalSources" placeholder="全部入组信号" aria-label="筛选入组信号" /><a-select v-model:value="watchSort" :options="[{label:'监控时间：新到旧',value:'desc'},{label:'监控时间：旧到新',value:'asc'}]" aria-label="监控时间排序" /></div>
   <a-table :data-source="monitored" :row-key="(w:any)=>`${w.chain}:${w.ca}`" size="small" :scroll="{x:1100}" :pagination="{current:watchPage,pageSize:10,showSizeChanger:false,onChange:(page:number)=>watchPage=page,showTotal:(n:number)=>`共 ${n} 个 CA`}" :locale="{emptyText:'暂无符合条件的监控 CA；等待所选来源的新信号通过准入。'}" :columns="[{title:'CA / 交易池',key:'ca',width:270},{title:'入组信号',key:'source',width:190},{title:'首次监控时间',key:'time',width:180},{title:'信号触发时间',key:'signalTime',width:180},{title:'状态 / 原因',key:'status',width:230},{title:'操作',key:'action',width:90}]">
    <template #bodyCell="{column,record}"><template v-if="column.key==='ca'"><ProjectIdentity :chain="record.chain" :ca="record.ca" /><small class="live-pair">池：{{record.pair_id}}</small></template><template v-else-if="column.key==='source'"><a-tag>{{signalSourceText(record.signal_source)}}</a-tag></template><template v-else-if="column.key==='time'">{{beijingTime(record.created_at)}}</template><template v-else-if="column.key==='signalTime'">{{beijingTime(record.signal_time,true)}}</template><template v-else-if="column.key==='status'"><a-tag :color="record.status==='monitoring'?'green':'orange'">{{watchText(record.status)}}</a-tag><p class="live-context">{{record.recovery_reason||'—'}}</p></template><template v-else-if="column.key==='action'"><a-button size="small" @click="selectPair(`${record.chain}:${record.ca}:${record.pair_id}`)">查看 K 线</a-button></template></template>
   </a-table>
  </section>
  <a-empty v-if="!detail.watches.length&&!chartAnchor" description="等待符合来源与链筛选的新信号；历史信号不会追加入场。" />
  <template v-else><div ref="chartElement" class="live-watch-picker"><label for="live-watch">项目 / 主池</label><a-select id="live-watch" :value="selectedWatch" show-search :filter-option="filterWatchOption" :options="watchOptions" @change="selectPair" /><a-button @click="chartEpoch++">刷新 K 线</a-button></div>
   <ProjectIdentity v-if="selectedWatch" :chain="selectedWatch.split(':')[0]" :ca="selectedWatch.split(':')[1]" full />
   <p v-if="locating" class="live-context">正在定位原始 K 线与成交点位…</p><p v-if="chartAnchor?.pairIds?.length>1" class="live-context">该笔持仓涉及 {{chartAnchor.pairIds.length}} 个交易池；当前仅绘制所选交易池的行情和点位，不拼接不同池 K 线。</p><p v-if="chartAnchor?.decision" class="live-context">当前定位的是{{chartAnchor.decision.status==='filled'?'成交':'未成交'}}决策；决策标记不代表实际成交。</p>
   <p v-if="chosenWatch" class="live-context">首次监控 {{beijingTime(chosenWatch.created_at)}} · 信号触发 {{beijingTime(chosenWatch.signal_time,true)}} · {{signalSourceText(chosenWatch.signal_source)}} · {{watchText(chosenWatch.status)}} · 市值 {{chosenWatch.current_mcap==null?'未知':formatNumber(chosenWatch.current_mcap)}} USD <span v-if="chosenWatch.recovery_reason">· {{chosenWatch.recovery_reason}}</span></p>
   <TradingViewChart v-if="chartSymbol" :key="`${chartSymbol}:${chartEpoch}`" :symbol="chartSymbol" :interval="detail.run.interval" :live-run-id="detail.run.id" :anchor="chartAnchor" />
  </template>
  <LivePortfolio :key="detail.run.id" :run-id="detail.run.id" :value-type="detail.run.value_type" @select-position="id=>locate('positionId',id)" @select-signal="id=>locate('orderId',id)" />
  <a-divider orientation="left">运行事件</a-divider><a-empty v-if="!detail.events.length" description="暂无运行事件" /><ol v-else class="live-event-list"><li v-for="(e,i) in detail.events" :key="i"><time>{{beijingTime(e.event_time,true)}}</time><strong>{{eventText(e.kind)}}</strong><ProjectIdentity v-if="e.ca" :chain="e.chain||detail.run.chain" :ca="e.ca" compact /><span v-else>系统</span><span>{{eventReason(e.payload)}}</span></li></ol>
 </section>
</div>
</template>

<style scoped>
.live-watch-picker :deep(.ant-select-selection-item){height:auto!important;line-height:normal!important;padding-block:4px}.live-watch-picker :deep(.ant-select-selector){height:auto!important;min-height:36px}.live-watch-picker :deep(.live-project-option){display:flex;align-items:center;gap:8px;flex-wrap:wrap;max-width:100%}.live-watch-picker :deep(.live-project-option>small){color:#53635e;font-size:11px}.live-pair{display:block;margin-top:4px}
.live-workspace,.live-detail,.live-history,.live-create{min-width:0;max-width:100%}
.live-monitor-list{min-width:0;margin-bottom:20px}.live-monitor-tools,.live-source-editor{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.live-monitor-tools>*{width:230px;max-width:100%}.live-source-editor .ant-select{flex:1;min-width:240px}.live-source-editor p{width:100%;font-size:12px;color:#53615d}.live-monitor-list :deep(.ant-table-cell){vertical-align:top}.live-monitor-list :deep(.ant-tag){white-space:normal}.live-monitor-list :deep(.ant-table-wrapper){max-width:100%}
.live-workspace{display:grid;gap:18px}.live-notice{margin-bottom:2px}.live-auth,.live-create,.live-history,.live-detail{background:#fff;border:1px solid #dfe6e3;border-radius:10px;padding:18px}.live-auth{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.live-auth>div{flex:1;min-width:240px}.live-auth strong{font-size:15px}.live-auth p,.live-section-head p{margin:3px 0 0;color:#53615d;font-size:12px}.live-auth .ant-input-password{width:min(280px,100%)}.live-layout{display:flex;flex-direction:column;gap:18px}.live-history,.live-create{width:100%}.live-history{order:0}.live-create{order:1}.live-create :deep(.ant-form){max-width:780px}.live-section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}.live-section-head h2{font-size:16px;margin:0}.live-section-head>span{font-size:12px;color:#53615d}.live-form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.live-form-row>.ant-form-item{min-width:0}.live-create :deep(.ant-input-number){width:100%}.live-run-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.live-run-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px;max-height:610px;overflow:auto;padding:2px}.live-run-row{width:100%;display:block;min-width:0;padding:16px;background:#fff;border:1px solid #dfe6e3;border-radius:9px;text-align:left;cursor:pointer;transition:background .15s,border-color .15s}.live-run-row:hover,.live-run-row.selected{background:#f1f7f4;border-color:#8db9ac}.live-run-row:focus-visible{outline:2px solid #176b5b;outline-offset:2px}.live-run-top,.live-run-foot{display:flex;justify-content:space-between;align-items:center;gap:8px}.live-run-top strong{font-size:15px;overflow-wrap:anywhere}.live-run-top .ant-tag{margin:0;flex:none}.live-run-meta{display:block;color:#53615d;margin-top:5px;font-size:12px;overflow-wrap:anywhere}.live-run-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:15px 0;padding:13px 0;border-block:1px solid #e8eeeb}.live-run-metrics>span{min-width:0}.live-run-metrics small{display:block;color:#53615d;font-size:11px}.live-run-metrics strong{display:block;margin-top:3px;font-size:16px;font-variant-numeric:tabular-nums}.live-run-metrics strong.value-positive{color:#2f7d5b}.live-run-metrics strong.value-negative{color:#c2413b}.live-run-foot{color:#53615d;font-size:11px;flex-wrap:wrap}.live-run-open{color:#176b5b;font-weight:600}.live-run-warning{color:#a35620}.live-summary{display:flex;flex-wrap:wrap;gap:8px 24px;padding:13px 0;border-block:1px solid #e8eeeb}.live-summary span{font-size:12px;color:#53615d}.live-summary strong{display:block;font-size:15px;color:#18211f;font-variant-numeric:tabular-nums}.live-summary strong.value-positive{color:#2f7d5b}.live-summary strong.value-negative{color:#c2413b}.live-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:15px}.live-actions span,.live-context{font-size:12px;color:#53615d}.live-watch-picker{display:flex;align-items:center;gap:10px}.live-watch-picker label{white-space:nowrap;font-size:13px}.live-watch-picker .ant-select{flex:1;min-width:0}.live-context{margin:10px 0}.live-address{display:block;max-width:260px;overflow-wrap:anywhere}.live-pair{color:#53615d;overflow-wrap:anywhere}.live-event-list{padding:0;margin:0;list-style:none;max-height:240px;overflow:auto}.live-event-list li{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #e8eeeb;font-size:12px}.live-event-list time{color:#53615d;white-space:nowrap}.live-event-list strong{min-width:100px}
@media(max-width:900px){.live-run-list{max-height:540px}}@media(max-width:680px){.live-auth,.live-create,.live-history,.live-detail{padding:14px}.live-auth .ant-input-password{width:100%}.live-form-row{grid-template-columns:1fr;gap:0}.live-run-list{grid-template-columns:1fr;max-height:580px}.live-run-row{padding:14px}.live-run-metrics{gap:10px}.live-watch-picker{align-items:stretch;flex-wrap:wrap}.live-watch-picker label{width:100%}.live-watch-picker .ant-select{flex-basis:100%}.live-event-list li{flex-wrap:wrap}.live-event-list li span{width:100%}}
</style>
