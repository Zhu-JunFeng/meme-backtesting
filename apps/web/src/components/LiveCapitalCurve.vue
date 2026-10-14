<script setup lang="ts">
import {computed,onBeforeUnmount,onMounted,ref,watch} from 'vue';
import {api} from '../api';
import {formatNumber,signedValue,valueTone} from '../format';
import {beijingTime} from '../time';
import {capitalGeometry,type CapitalPoint} from '../capital-chart';
const props=defineProps<{runId:string;mode:'paper'|'live';status:string}>();
type Curve={kind:'equity'|'realized';initialCapital:number;points:CapitalPoint[];total:number;sampled:boolean;asOf:number;lastDataTime:number|null;incompleteCount?:number;closedCount?:number};
const kind=ref<'equity'|'realized'>(props.mode==='paper'?'equity':'realized'),data=ref<Curve>(),loading=ref(false),error=ref('');
const host=ref<HTMLElement>(),width=ref(600),cursor=ref<number>();
let epoch=0,abort:AbortController|undefined,timer:number|undefined,observer:ResizeObserver|undefined;
const points=computed(()=>data.value?.points.filter(p=>Number.isFinite(p.time)&&Number.isFinite(p.equity))??[]);
const invalidCount=computed(()=>(data.value?.points.length??0)-points.value.length);
const geometry=computed(()=>capitalGeometry(points.value,data.value?.initialCapital??0,width.value,kind.value==='realized'));
const selected=computed(()=>points.value[Math.min(cursor.value??points.value.length-1,points.value.length-1)]);
const delta=computed(()=>selected.value&&data.value?selected.value.equity-data.value.initialCapital:null);
const percent=computed(()=>delta.value!==null&&data.value&&data.value.initialCapital>0?delta.value/data.value.initialCapital*100:null);
const title=computed(()=>kind.value==='equity'?'账户总权益':props.mode==='live'?'累计已实现资金参考':'累计已实现资金');
async function refresh(reset=false){
 const version=++epoch;abort?.abort();abort=new AbortController();loading.value=true;error.value='';
 if(reset){data.value=undefined;cursor.value=undefined;}
 try{const result=await api.get(`/live-runs/${props.runId}/capital-curve`,{params:{kind:kind.value},signal:abort.signal});if(version===epoch)data.value=result.data;}
 catch(e:any){if(version===epoch&&e.code!=='ERR_CANCELED')error.value=e.response?.data?.message??'资金曲线读取失败；已有数据未更新。';}
 finally{if(version===epoch)loading.value=false;}
}
function pointAt(event:PointerEvent){
 const rect=(event.currentTarget as SVGElement).getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width*width.value;
 let nearest=0;for(let i=1;i<points.value.length;i++)if(Math.abs(geometry.value.x(points.value[i].time)-x)<Math.abs(geometry.value.x(points.value[nearest].time)-x))nearest=i;
 cursor.value=nearest;
}
watch(()=>props.runId,()=>{kind.value=props.mode==='paper'?'equity':'realized';void refresh(true);});
watch(kind,()=>void refresh(true));
watch(()=>props.status,()=>void refresh());
onMounted(()=>{
 observer=new ResizeObserver(entries=>{width.value=Math.max(260,entries[0].contentRect.width);});if(host.value)observer.observe(host.value);
 void refresh(true);timer=window.setInterval(()=>{if(!document.hidden&&props.status==='running'&&!loading.value)void refresh();},15000);
});
onBeforeUnmount(()=>{epoch++;abort?.abort();observer?.disconnect();window.clearInterval(timer);});
</script>
<template>
 <section ref="host" class="capital-curve" aria-label="策略资金曲线">
  <header><div><h3>策略资金曲线</h3><p>{{title}} · USD · 北京时间 UTC+8</p></div><div class="capital-tools"><a-radio-group v-if="mode==='paper'" v-model:value="kind" button-style="solid" aria-label="资金曲线口径"><a-radio-button value="equity">总权益</a-radio-button><a-radio-button value="realized">已实现资金</a-radio-button></a-radio-group><a-button :loading="loading" @click="refresh()">刷新曲线</a-button></div></header>
  <p class="capital-note" v-if="kind==='equity'">现金＋持仓估值，不含未来卖出成本。历史快照使用当时最近已知行情，无法据此保证估值新鲜度；不代表当前可成交余额。</p>
  <p class="capital-note" v-else>{{mode==='live'?'配置的初始额度基准':'初始资金'}}＋已完整平仓交易累计净盈亏，已计入成交成本，不含未平仓浮盈亏。{{mode==='live'?'不是钱包实际余额，不包含充值、提现及外部交易。':''}}</p>
  <a-alert v-if="error" type="warning" show-icon :message="error"><template #action><a-button size="small" :loading="loading" @click="refresh()">重试</a-button></template></a-alert>
  <a-skeleton v-if="loading&&!data" active :paragraph="{rows:5}" />
  <template v-else-if="data">
   <p v-if="data.incompleteCount" class="capital-warning">{{data.incompleteCount}} 笔历史持仓信息不完整，未计入已平仓资金曲线。</p>
   <p v-if="invalidCount" class="capital-warning">{{invalidCount}} 个无效数据点无法绘制，未补造数值。</p>
   <a-empty v-if="!points.length" :description="kind==='equity'?'暂无账户权益快照，可切换已实现资金查看成交结果。':'暂无完整平仓交易，尚未形成已实现资金曲线。'"><p>初始{{mode==='live'?'额度基准':'资金'}}：{{formatNumber(data.initialCapital)}} USD</p><a-button v-if="kind==='equity'" @click="kind='realized'">查看已实现资金</a-button></a-empty>
   <template v-else>
    <div class="capital-readout" aria-live="polite"><time>{{beijingTime(selected?.time)}}</time><span>{{kind==='equity'?'权益':'统计资金'}} <strong>{{formatNumber(selected?.equity)}} USD</strong></span><span>相对初始资金 <strong :class="valueTone(delta)">{{signedValue(delta)}} / {{percent===null?'—':signedValue(percent)+'%'}}</strong></span><template v-if="kind==='equity'"><span>现金 {{formatNumber(selected?.cash)}}</span><span>浮盈亏 <strong :class="valueTone(selected?.unrealized)">{{signedValue(selected?.unrealized)}}</strong></span></template></div>
    <svg :viewBox="`0 0 ${width} 242`" role="img" :aria-label="`${title}，${points.length} 个展示点`" class="capital-svg" @pointermove="pointAt" @pointerdown="pointAt">
     <g v-for="tick in geometry.ticks" :key="tick"><line :x1="geometry.left" :x2="geometry.right" :y1="geometry.y(tick)" :y2="geometry.y(tick)" stroke="#e8eeeb"/><text :x="geometry.left-8" :y="geometry.y(tick)+4" text-anchor="end">{{formatNumber(tick)}}</text></g>
     <line :x1="geometry.left" :x2="geometry.right" :y1="geometry.y(data.initialCapital)" :y2="geometry.y(data.initialCapital)" stroke="#6d7e77" stroke-dasharray="4 4"/>
     <path :d="geometry.path" fill="none" stroke="#176b5b" stroke-width="2"/>
     <g v-if="selected"><line :x1="geometry.x(selected.time)" :x2="geometry.x(selected.time)" :y1="geometry.top" :y2="geometry.bottom" stroke="#53615d" stroke-dasharray="3 4"/><circle :cx="geometry.x(selected.time)" :cy="geometry.y(selected.equity)" r="4" fill="#176b5b" stroke="#fff" stroke-width="2"/></g>
     <text :x="geometry.left" y="238">{{beijingTime(points[0].time).slice(5,16)}}</text><text :x="geometry.right" y="238" text-anchor="end">{{beijingTime(points[points.length-1].time).slice(5,16)}}</text>
    </svg>
    <label class="capital-scrub">拖动查看记录<input type="range" min="0" :max="points.length-1" :value="cursor??points.length-1" aria-label="选择资金曲线时间点" @input="cursor=Number(($event.target as HTMLInputElement).value)" /></label>
    <p class="capital-note">虚线：初始{{mode==='live'?'额度基准':'资金'}} {{formatNumber(data.initialCapital)}} USD · {{data.sampled?`全历史 ${data.total} 条记录，保留首尾和极值展示 ${points.length} 点（展示抽样）`:`全历史 ${data.total} 个数据点`}}</p>
   </template>
   <footer>最后数据：{{beijingTime(data.lastDataTime)}} · 查询：{{beijingTime(data.asOf)}}<span v-if="status==='running'"> · 每 15 秒刷新</span></footer>
  </template>
 </section>
</template>
<style scoped>
.capital-curve{min-width:0;margin:24px 0;padding:20px 0;border-block:1px solid #dfe6e3}.capital-curve header{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.capital-curve h3{margin:0;font-size:16px;color:#18211f}.capital-curve header p,.capital-note,.capital-curve footer{font-size:12px;color:#53615d;margin:6px 0 12px;line-height:1.6}.capital-tools{display:flex;gap:8px;flex-wrap:wrap}.capital-readout{display:flex;gap:8px 20px;flex-wrap:wrap;min-height:54px;margin-top:16px;font-size:13px;font-variant-numeric:tabular-nums}.capital-readout time{flex-basis:100%;color:#53615d}.capital-readout strong{font-weight:600}.value-positive{color:#2f7d5b}.value-negative,.capital-warning{color:#c2413b}.capital-svg{display:block;width:100%;touch-action:pan-y}.capital-svg text{fill:#53615d;font-size:11px;font-variant-numeric:tabular-nums}.capital-scrub{display:flex;gap:12px;align-items:center;font-size:12px;color:#53615d}.capital-scrub input{flex:1;min-width:0;accent-color:#176b5b;height:44px}.capital-warning{font-size:12px}.capital-curve footer{margin:8px 0 0}.capital-tools .ant-btn{min-height:36px}
@media(max-width:680px){.capital-tools{width:100%;justify-content:space-between}.capital-tools :deep(.ant-radio-button-wrapper){height:44px;line-height:42px;padding-inline:12px}.capital-tools .ant-btn{min-height:44px}.capital-readout{gap:6px 12px}.capital-readout>span{flex-basis:100%}.capital-curve{margin:20px 0}.capital-scrub{gap:8px}}
</style>
