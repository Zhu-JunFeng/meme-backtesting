<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref} from 'vue';
import {api} from '../api';
import {beijingTime} from '../time';
const emit=defineEmits<{alerts:[number]}>();
const data=ref<any>(),history=ref<any[]>([]),busy=ref(false),error=ref(''),hours=ref(24);
let version=0,timer:ReturnType<typeof setInterval>;
const worker=computed(()=>data.value?.samples.find((s:any)=>s.source==='worker')?.metrics);
const host=computed(()=>data.value?.samples.find((s:any)=>s.source==='api')?.metrics.host);
const backend=computed(()=>data.value?.samples.find((s:any)=>s.source==='api')?.metrics);
const state=(s:string)=>({connected:'正常',scanning:'扫描中',stalled:'扫描停滞',retrying:'退避重试',disabled:'未启用',unconfigured:'未配置',error:'异常',disconnected:'未连接'}[s]??'未知');
const color=(s:string)=>['stalled','error','disconnected'].includes(s)?'red':['retrying','unconfigured'].includes(s)?'orange':s==='connected'?'green':'default';
const n=(v:any,suffix='')=>typeof v==='number'&&Number.isFinite(v)?v.toFixed(2)+suffix:'—';
async function load(){if(busy.value||document.hidden)return;const v=++version;busy.value=true;error.value='';try{const [status,trend]=await Promise.allSettled([api.get('/operations/status'),api.get('/operations/history',{params:{hours:hours.value}})]);if(v!==version)return;if(status.status==='fulfilled'){data.value=status.value.data;emit('alerts',data.value.alerts.length);}else throw status.reason;if(trend.status==='fulfilled')history.value=trend.value.data;else error.value='历史指标暂不可查询，当前状态仍可查看';}catch{if(v===version)error.value='运维状态暂不可获取，请稍后重试';}finally{if(v===version)busy.value=false;}}
const points=computed(()=>history.value.filter(s=>s.source==='api'&&s.metrics.host).map(s=>({time:s.sampled_at,...s.metrics.host})));
function path(key:string){const p=points.value;return p.map((s,i)=>`${i?'L':'M'} ${p.length===1?0:i/(p.length-1)*900} ${120-Math.min(100,Math.max(0,s[key]??0))*1.1}`).join(' ');}
onMounted(()=>{void load();timer=setInterval(load,60000);document.addEventListener('visibilitychange',load);});
onUnmounted(()=>{version++;clearInterval(timer);document.removeEventListener('visibilitychange',load);});
</script>
<template>
 <section class="operations">
  <div class="ops-toolbar"><div><strong>{{data?.alerts.length?'当前有 '+data.alerts.length+' 项告警':'运行状态'}}</strong><p>每分钟采样 · 保留七天 · 最近采样 {{beijingTime(data?.sampledAt)}}（北京时间）</p></div><a-button :loading="busy" @click="load">刷新缓存状态</a-button></div>
  <a-alert v-if="error" :message="error" type="warning" show-icon />
  <a-skeleton v-if="!data&&busy" active />
  <template v-if="data">
   <div class="ops-alerts"><a-alert v-for="alert in data.alerts" :key="alert.key" :type="alert.level==='error'?'error':'warning'" :message="alert.message" show-icon /><a-alert v-if="!data.alerts.length" type="success" message="当前采样未发现告警；无成交不代表行情异常。" show-icon /></div>
   <h2>项目发现与行情连接</h2>
   <div class="ops-table"><table><thead><tr><th>来源</th><th>状态</th><th>最近成功／消息</th><th>当前阶段与数量</th><th>恢复情况</th></tr></thead><tbody>
    <tr v-for="(s,key) in worker?.discovery" :key="key"><td>{{String(key)==='wallet'?'钱包买入':'XXYY 项目列表'}}</td><td><a-tag :color="color(s.state)">{{state(s.state)}}</a-tag></td><td>{{beijingTime(s.lastSuccessAt)}}<small>最近推进 {{beijingTime(s.progressAt)}}</small></td><td>{{s.stage??'—'}}<small>扫描 {{s.scanned??'—'}} · 接收 {{s.received??'—'}}</small></td><td>超时 {{s.timeouts??0}} · 恢复 {{s.recoveries??0}}<small v-if="s.nextRetryAt">下次重试 {{beijingTime(s.nextRetryAt)}}</small><small>{{s.error}}</small></td></tr>
    <tr v-for="s in worker?.connections" :key="s.name"><td>{{s.name}}</td><td><a-tag :color="color(s.state)">{{s.enabled?state(s.state):'未启用'}}</a-tag></td><td>{{beijingTime(s.lastMessageAt)}}</td><td>订阅确认 {{s.subscriptionCount??'—'}} / {{s.desiredCount??'—'}}</td><td>重连 {{s.reconnectAttempts??'—'}}</td></tr>
   </tbody></table></div>
   <h2>服务与服务器</h2>
   <a-descriptions bordered size="small" :column="{xs:1,sm:2,lg:3}">
    <a-descriptions-item label="PostgreSQL">{{state(backend?.database?.state)}} · {{n(backend?.database?.latencyMs,' ms')}}</a-descriptions-item><a-descriptions-item label="Redis">{{state(backend?.redis?.state)}} · {{n(backend?.redis?.latencyMs,' ms')}}<small>Worker 缓存 {{worker?.redisState??'未知'}}</small></a-descriptions-item>
    <a-descriptions-item label="数据库连接池">使用 {{worker?.dbPool?.total-worker?.dbPool?.idle||0}} · 等待 {{worker?.dbPool?.waiting??'—'}}</a-descriptions-item>
    <a-descriptions-item label="Worker">内存 {{n(worker?.rss/1048576,' MiB')}} · 运行 {{n(worker?.uptime/3600,' 小时')}}</a-descriptions-item><a-descriptions-item label="事件循环延迟">平均 {{n(worker?.eventLoopMeanMs,' ms')}} · 最大 {{n(worker?.eventLoopMaxMs,' ms')}}</a-descriptions-item><a-descriptions-item label="任务／项目">模拟 {{worker?.tasks?.paper??'—'}} · 实盘 {{worker?.tasks?.live??'—'}} · 恢复中 {{worker?.tasks?.recovering??'—'}}</a-descriptions-item>
    <a-descriptions-item label="历史补数">执行 {{worker?.history?.active??'—'}} · 排队 {{worker?.history?.queued??'—'}}<small>成功 {{worker?.history?.success??'—'}} / 失败 {{worker?.history?.failed??'—'}} · {{n(worker?.history?.lastDurationMs,' ms')}}</small><small>{{worker?.history?.lastError}}</small></a-descriptions-item>
    <a-descriptions-item label="行情质量">非法 {{worker?.quality?.invalid??'—'}} · 缺口 {{worker?.quality?.gaps??'—'}} · 溢出 {{worker?.quality?.overflow??'—'}}</a-descriptions-item>
    <a-descriptions-item label="CPU／负载">{{n(host?.cpuPercent,'%')}} · 1分钟负载 {{n(host?.load?.[0])}}</a-descriptions-item><a-descriptions-item label="可用内存">{{n(host?.memoryAvailable/1048576,' MiB')}} · {{n(host?.availableMemoryPercent,'%')}}</a-descriptions-item><a-descriptions-item label="磁盘／inode">{{n(host?.diskPercent,'%')}} / {{n(host?.inodePercent,'%')}}<small>可用 {{n(host?.diskAvailable/1073741824,' GiB')}}</small></a-descriptions-item><a-descriptions-item label="网络收发">接收 {{n(host?.networkRxBytesPerSecond/1024,' KiB/s')}} · 发送 {{n(host?.networkTxBytesPerSecond/1024,' KiB/s')}}</a-descriptions-item>
   </a-descriptions>
   <div class="ops-toolbar"><h2>服务器趋势</h2><a-select v-model:value="hours" :options="[{value:24,label:'最近24小时'},{value:168,label:'最近7天'}]" @change="load" /></div>
   <div v-if="points.length" class="ops-trend"><p><span class="cpu">CPU</span> · <span class="disk">磁盘使用率</span> · 0–100%</p><svg viewBox="0 0 900 130" role="img" aria-label="CPU和磁盘使用率历史趋势"><path :d="path('cpuPercent')" stroke="#176b5b" fill="none" stroke-width="2" /><path :d="path('diskPercent')" stroke="#376a9f" fill="none" stroke-width="2" /></svg><div class="ops-toolbar"><small>{{beijingTime(points[0].time)}}</small><small>{{beijingTime(points.at(-1)?.time)}}</small></div></div>
   <a-empty v-else description="尚无历史采样，首批指标写入后即可查看趋势" />
   <p class="ops-note">连接状态与扫描进度分别核验；来源健康不代表成交完整。磁盘及网络为服务器汇总，监控不额外请求行情。</p>
  </template>
 </section>
</template>
<style scoped>
.operations{background:#fff;border:1px solid #dfe6e3;border-radius:10px;padding:20px;min-width:0}.ops-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}.ops-toolbar p,.ops-note{color:#53615d;font-size:13px}.ops-alerts{display:flex;flex-direction:column;gap:8px;margin:18px 0}h2{font-size:16px;margin:24px 0 12px}small{display:block;color:#53615d;overflow-wrap:anywhere}.ops-table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:800px;font-size:13px}th,td{text-align:left;vertical-align:top;padding:12px;border-bottom:1px solid #dfe6e3}th{background:#f8fafb}.ops-trend{background:#f8fafb;padding:12px}.ops-trend svg{width:100%;height:160px}.cpu{color:#176b5b}.disk{color:#376a9f}@media(max-width:680px){.operations{padding:14px}.ops-toolbar{align-items:flex-start;flex-wrap:wrap}.ops-toolbar p{line-height:1.6}}
</style>
