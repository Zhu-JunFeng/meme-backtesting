<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { eventLabels as labels, marketValue, changePercent, formatNumber, preciseValue, signedValue, valueTone, exitLabel, invalidationEvidence } from '../format';
import FibAudit from './FibAudit.vue';
import { partitionMarkers } from '../chartMarkers';
const props=defineProps<{symbol:string;interval:string;runId?:string;startTime?:number|null;endTime?:number|null;includeEndOfBacktest?:boolean;signalTypes?:string;anchor?:{tradeId?:string;from?:number;to?:number;start?:number;end?:number;empty?:boolean;fib?:any;fibFrom?:number;fibTo?:number}}>();
const filters=()=>({includeEndOfBacktest:props.includeEndOfBacktest ?? false,signalTypes:props.signalTypes ?? ''});
const showFib=ref(true),fibView=ref('full'),fib=ref<any>();let fibIds:any[]=[],fibEpoch=0;
const selectedBuy=ref<any>(),cursorValue=ref<number>(),selectedEvent=ref<any>();
const isMcap=computed(()=>props.symbol.endsWith(':mcap'));
const movement=computed(()=>changePercent(cursorValue.value!,Number(selectedBuy.value?.price)));
const displayValue=(n:number)=>isMcap.value?marketValue(n):preciseValue(n);
let ready=false,referenceId:any,referenceEpoch=0;
const markMap=new Map<string,any>(),shapeMap=new Map<any,any>();
const fetching=ref(false);let focused:any,focusEpoch=0;
const container=ref<HTMLDivElement>(),error=ref("");let widget:any,version=0,markerVersion=0;
let controller=new AbortController(),rangeTimer:number|undefined;
let marksEpoch=0;
const missingMarkers=ref(0);
function clearMarkers(chart:any){
 markerVersion++;marksEpoch++;markMap.clear();
 chart.clearMarks();
 for(const id of shapeMap.keys())try{chart.removeEntity(id);}catch{}shapeMap.clear();
}
function refreshMarkers(chart:any,v:number){
 if(v!==version||!ready)return;
 clearMarkers(chart);chart.refreshMarks();void loadMarkers(chart,v);
}
function scheduleMarkers(v:number){
 if(v!==version||!ready)return;
 const chart=widget.activeChart();clearMarkers(chart);
 window.clearTimeout(rangeTimer);rangeTimer=window.setTimeout(()=>refreshMarkers(chart,v),200);
}
const resolutions:Record<string,string>={"30s":"30S","1m":"1","5m":"5","15m":"15","1h":"60","4h":"240","1d":"D"};
const seconds:Record<string,number>={"30s":30,"1m":60,"5m":300,"15m":900,"1h":3600,"4h":14400,"1d":86400};
const markText=(m:any)=>`${m.event_label ?? ''} ${exitLabel(m)} · ${isMcap.value?"市值":"价格"} ${displayValue(Number(m.price))} · 数量 ${preciseValue(m.quantity)}${props.includeEndOfBacktest===false && m.excluded_end?' · 不计入当前统计':''}\n${m.signal_type==='invalidation'?invalidationEvidence(m.invalidation_detail ?? m.reason_json?.invalidation).join('\n'):JSON.stringify(m.reason_json)}`;
const eventSummary=(m:any)=>`${m.event_label ?? ''} ${exitLabel(m)} · ${new Date(Number(m.time)).toLocaleString()} · ${isMcap.value?'市值':'价格'} ${displayValue(Number(m.price))} · 数量 ${preciseValue(m.quantity)} · ${m.signal_type==='invalidation'?invalidationEvidence(m.invalidation_detail ?? m.reason_json?.invalidation).join('；'):m.reason_json?.message || labels[m.reason_json?.priority] || '策略条件满足'}${props.includeEndOfBacktest===false && m.excluded_end?' · 不计入当前统计':''}`;
function clearSelection(){selectedBuy.value=undefined;selectedEvent.value=undefined;cursorValue.value=undefined;referenceEpoch++;if(referenceId&&ready)try{widget.activeChart().removeEntity(referenceId);}catch{}referenceId=undefined;}
async function drawReference(){
 if(!ready||!selectedBuy.value||!loadedTimes.has(Number(selectedBuy.value.time)))return;const request=++referenceEpoch,chart=widget.activeChart();
 if(referenceId)try{chart.removeEntity(referenceId);}catch{}referenceId=undefined;
 const id=await chart.createShape({time:Number(selectedBuy.value.time)/1000,price:Number(selectedBuy.value.price)},{shape:'horizontal_line',text:`${selectedBuy.value.event_label || '买入'} 参考`,lock:true,disableSave:true,disableUndo:true,disableSelection:true,overrides:{linecolor:'#176b5b',linestyle:2,showLabel:true}});
 if(request!==referenceEpoch){try{chart.removeEntity(id);}catch{}return;}referenceId=id;
}
function selectEvent(event:any){
 if(!event)return;selectedEvent.value=event;
 if(['entry','add'].includes(event.signal_type)){selectedBuy.value=event;cursorValue.value=undefined;void drawReference().catch(()=>{error.value='买入参考线加载失败，请重新选择事件';});}
}
async function markerRows(from:number,to:number) {
 const [chain,ca,pairId]=props.symbol.split(":"),items:any[]=[];
 for(let page=1;;page++) {
  const data=await get(`/api/backtests/${props.runId}/signals`,{chain,ca,pairId,from:Math.floor(from*1000),to:Math.ceil(to*1000),page,pageSize:500,...filters()});
  items.push(...data.items);if(page*500>=data.total)return items;
 }
}
async function get(path:string,params:Record<string,any>) {
 const query=new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));
 const response=await fetch(path+"?"+query,{signal:controller.signal});if(!response.ok)throw new Error("请求失败 "+response.status);return response.json();
}
async function loadMarkers(chart:any,v:number) {
 if(!props.runId || v!==version)return;
 const mv=++markerVersion,range=chart.getVisibleRange(),[chain,ca,pairId]=props.symbol.split(":");
 if(!range || range.to<=range.from)return;
 const markers:any[]=[];
 try {
 for(let page=1;;page++){
  const data=await get(`/api/backtests/${props.runId}/signals`,{chain,ca,pairId,from:Math.floor(range.from*1000),to:Math.ceil(range.to*1000),page,pageSize:500,...filters()});
  if(v!==version || mv!==markerVersion)return;markers.push(...data.items);
  if(page*500>=data.total)break;
 }
 for(const id of shapeMap.keys())try{chart.removeEntity(id);}catch{}shapeMap.clear();
 const eligible=partitionMarkers(markers,loadedTimes,range);missingMarkers.value=eligible.missing.length;
 for(const marker of eligible.drawable){
  if(v!==version || mv!==markerVersion)return;
  const text=marker.event_label || labels[marker.signal_type] || marker.signal_type;
  const id=await chart.createShape({time:Number(marker.time)/1000,price:Number(marker.price)},{shape:marker.signal_type==="risk_event"?"flag":["entry","add"].includes(marker.signal_type)?"arrow_up":"arrow_down",text,lock:true,disableSave:true,disableUndo:true,overrides:{color:marker.signal_type==="risk_event"?"#b7791f":["entry","add"].includes(marker.signal_type)?"#176b5b":"#c2413b"}});
  if(v!==version || mv!==markerVersion) { try { chart.removeEntity(id); } catch {} return; }
  shapeMap.set(id,marker);markMap.set(String(marker.id),marker);
 }
 }catch(e:any){if(v===version && e.name!=="AbortError")error.value="事件标注加载失败，可切换交易池重试";}
}
function reset(){clearSelection();fibEpoch++;fibIds=[];ready=false;version++;markerVersion++;marksEpoch++;loadedTimes.clear();missingMarkers.value=0;controller.abort();controller=new AbortController();window.clearTimeout(rangeTimer);widget?.remove();widget=undefined;shapeMap.clear();markMap.clear();}
let loadedTimes=new Set<number>();
async function drawFib(chart:any,v:number){
 const request=++fibEpoch;for(const id of fibIds)try{chart.removeEntity(id);}catch{}fibIds=[];
 const f=fib.value;if(!showFib.value||f?.status!=='available')return;
 const anchor=focused ?? props.anchor,end=f.exitTime ?? anchor?.fibTo ?? anchor?.to;
 const create=async(points:any[],shape:string,text:string,overrides:any={})=>{
  if(v!==version||request!==fibEpoch)return;
  const options={shape,text,lock:true,disableSave:true,disableUndo:true,disableSelection:true,overrides};
  const id=points.length===1?await chart.createShape(points[0],options):await chart.createMultipointShape(points,options);
  if(v!==version||request!==fibEpoch){try{chart.removeEntity(id);}catch{}return;}fibIds.push(id);
 };
 const point=(time:number,price:number)=>({time:time/1000,price});
 // TradingView snaps missing-bar anchors to neighbouring bars: never pass a missing timestamp as a real pivot.
 const hasLow=loadedTimes.has(f.low.time),hasHigh=loadedTimes.has(f.high.time);
 if(hasLow&&hasHigh)await create([point(f.low.time,f.low.value),point(f.high.time,f.high.value)],'trend_line',`拉升 ${formatNumber((f.high.value/f.low.value-1)*100)}% · ${f.high.index-f.low.index} 根`,{linecolor:'#176b5b',textcolor:'#176b5b',linewidth:2,fontsize:11,showLabel:true});
 for(const [name,p] of [['Swing Low',f.low],['Swing High',f.high]] as const)if(loadedTimes.has(p.time))await create([point(p.time,p.value)],'text',`${name} ${displayValue(p.value)}\n${new Date(p.time).toISOString()}${p.synthetic?' · 补齐 K 线':''}`,{color:'#176b5b',fontsize:12});
 if(loadedTimes.has(f.confirmed.time))await create([point(f.confirmed.time,f.high.value)],'vertical_line',`Pivot 确认 ${new Date(f.confirmed.time).toISOString()}`,{linecolor:'#65766e',linestyle:2,showLabel:true});
 const start=hasHigh?f.high.time:f.entryTime;
 if(!loadedTimes.has(start))return;
 const zoneKeys=new Set<string>();for(const z of f.zones){const key=`${z.lower}:${z.upper}`;if(zoneKeys.has(key))continue;zoneKeys.add(key);await create([point(start,z.upper),point(end,z.lower)],'rectangle','',{color:'#176b5b',backgroundColor:'#176b5b',fillBackground:true,transparency:92,linewidth:1});}
 for(const [index,line] of f.levels.entries())await create([point(start,line.value)],'horizontal_line',`Fib ${line.ratio} · ${displayValue(line.value)}`,{linecolor:line.uses.length?'#176b5b':'#7b8580',textcolor:'#31483f',fontsize:11,horzLabelsAlign:index%2?'right':'left',vertLabelsAlign:'top',linewidth:1,linestyle:line.uses.length?0:2,showLabel:true,showPrice:false});
 for(const [index,line] of f.thresholds.entries())await create([point(start,line.value)],'horizontal_line',`${line.label.includes('止损')?'止损':'失效'} · ${displayValue(line.value)}`,{linecolor:'#b42318',textcolor:'#b42318',fontsize:11,horzLabelsAlign:index%2?'right':'left',vertLabelsAlign:'bottom',linestyle:2,showLabel:true,showPrice:false});
}
async function mountChart(){
 reset();const v=version,symbol=props.symbol,step=seconds[props.interval] || 30;error.value="";
 if(!container.value)return;
 const tv=(window as any).TradingView;
 if(!tv){error.value="未找到 TradingView charting_library，请检查本地组件资源";return;}
 try{
 const original=focused ?? props.anchor;fib.value=original?.fib;
 const dataAnchor=original?.fib?.status==='available'?{...original,from:original.fibFrom,to:original.fibTo}:original;
 const anchor=fibView.value==='full'?dataAnchor:original;
 const initial:any[]=[];
 if(dataAnchor && !dataAnchor.empty && dataAnchor.from!==undefined){
  fetching.value=true;let to=Math.floor(dataAnchor.to/1000)+step;
  for(;;){const x=await get('/api/tv/history',{symbol,resolution:resolutions[props.interval],runId:props.runId,from:Math.floor(dataAnchor.from/1000),to});if(v!==version)return;if(!x.t?.length)break;
   initial.unshift(...x.t.map((t:number,i:number)=>({time:t*1000,open:x.o[i],high:x.h[i],low:x.l[i],close:x.c[i],volume:x.v[i]})));
   if(x.t.length<5000 || x.t[0]*1000<=dataAnchor.from)break;to=x.t[0];
  }
  if(!initial.length)error.value='买卖点附近缺少原始 K 线，无法显示对应行情；不会补造。';
  else if([dataAnchor.start,dataAnchor.end].some(t=>t!==undefined && !initial.some(b=>b.time===t)))error.value='部分事件对应原始 K 线缺失；保留事件记录，不补造行情。';
  fetching.value=false;
 }
 loadedTimes=new Set(initial.map(b=>b.time));
 if(fib.value?.status==='available' && [fib.value.low,fib.value.high,fib.value.confirmed].some(p=>p.synthetic || !loadedTimes.has(p.time)))error.value='部分 Fib 锚点对应补齐或缺失 K 线，未在相邻真实 K 线上冒画锚点；准确时间和值见 Fib 核验明细。';
 const localWidget=new tv.widget({container:container.value,library_path:"/charting_library/",symbol,interval:resolutions[props.interval],timezone:"Etc/UTC",theme:"Light",autosize:true,
 enabled_features:['two_character_bar_marks_labels',...(window.matchMedia('(max-width:680px)').matches?['hide_left_toolbar_by_default']:[])],
 custom_formatters:{priceFormatterFactory:()=>({format:(value:number)=>displayValue(value)}),studyFormatterFactory:(format:any)=>format.type==='volume'?{format:(value:number)=>formatNumber(value)}:null},
 disabled_features:["header_symbol_search","header_resolutions","header_compare","timeframes_toolbar","use_localstorage_for_settings","legend_inplace_edit","symbol_search_hot_key","show_interval_dialog_on_key_press"],
 datafeed:{
  onReady:(cb:any)=>setTimeout(()=>cb({supported_resolutions:[resolutions[props.interval]],supports_time:false,supports_marks:true}),0),
  getMarks:(_info:any,from:number,to:number,cb:any)=>{
   if(!props.runId){cb([]);return;}
   const request=marksEpoch;
   markerRows(from,to).then(items=>{if(v!==version||request!==marksEpoch)return;const visible=ready?localWidget.activeChart().getVisibleRange():null;
    const {drawable}=partitionMarkers(items,loadedTimes,{from:Math.max(from,visible?.from ?? from),to:Math.min(to,visible?.to ?? to)});
    drawable.forEach(m=>markMap.set(String(m.id),m));cb(drawable.map(m=>({id:m.id,time:Number(m.time)/1000,color:m.signal_type==="risk_event"?"yellow":["entry","add"].includes(m.signal_type)?"green":"red",text:markText(m).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"),label:m.event_label || (m.signal_type==="risk_event"?"!":m.signal_type==="entry"?"买":m.signal_type==="add"?"加":"卖"),labelFontColor:"white",minSize:28})));}).catch(()=>{if(v===version&&request===marksEpoch)cb([]);});
  },
  resolveSymbol:(_s:any,cb:any,onError:any)=>get("/api/tv/symbols",{symbol}).then(data=>{if(v===version)cb({...data,supported_resolutions:[resolutions[props.interval]]});}).catch(onError),
  getBars:(_info:any,_resolution:string,range:any,onResult:any,onError:any)=>{
   if(range.firstDataRequest && anchor && !anchor.empty){setTimeout(()=>{if(v===version){onResult(initial,{noData:!initial.length});scheduleMarkers(v);}},0);return;}
   let from=range.from,to=range.to;
   if(range.firstDataRequest && props.endTime!==null && props.endTime!==undefined){to=Math.floor(props.endTime/1000)+step;from=to-step*Math.max(300,range.countBack || 300);}
   get("/api/tv/history",{symbol,resolution:resolutions[props.interval],runId:props.runId,from,to,countBack:Math.min(5000,Math.max(range.countBack || 300,Math.ceil((to-from)/step)))})
   .then(x=>{if(v!==version)return;const bars=x.t?x.t.map((t:number,i:number)=>({time:t*1000,open:x.o[i],high:x.h[i],low:x.l[i],close:x.c[i],volume:x.v[i]})):[];bars.forEach((b:any)=>loadedTimes.add(b.time));onResult(bars,{noData:!bars.length});scheduleMarkers(v);if(ready)void drawFib(localWidget.activeChart(),v).catch(()=>{});})
   .catch((e:any)=>{if(v===version && e.name!=="AbortError"){error.value="K 线加载失败";onError(String(e));}});
  },
  searchSymbols:(_i:any,_e:any,_t:any,cb:any)=>cb([]),
  subscribeBars:()=>{},unsubscribeBars:()=>{}
 }});
 widget=localWidget;
 localWidget.onChartReady(()=>{
  if(v!==version)return;ready=true;const chart=localWidget.activeChart();
  localWidget.subscribe('onMarkClick',(id:any)=>{if(v===version)selectEvent(markMap.get(String(id)));});
  localWidget.subscribe('drawing_event',(id:any,type:string)=>{if(v===version && type==='click')selectEvent(shapeMap.get(id));});
  chart.crossHairMoved().subscribe(null,(p:any)=>{if(v===version && selectedBuy.value)cursorValue.value=Number.isFinite(p.price)?p.price:undefined;});
  if(selectedBuy.value)void drawReference();
  chart.onVisibleRangeChanged().subscribe(null,()=>scheduleMarkers(v));
  refreshMarkers(chart,v);
  void drawFib(chart,v).catch(()=>{if(v===version)error.value='Fib 绘图失败，请重新加载；核验明细仍可查看';});
  if(anchor && !anchor.empty)chart.setVisibleRange({from:anchor.from/1000,to:anchor.to/1000+step}).then(()=>loadMarkers(chart,v)).catch(()=>{});
  else if(props.endTime!==null && props.endTime!==undefined)chart.setVisibleRange({from:Math.max((props.startTime ?? 0)/1000,props.endTime/1000-step*200),to:props.endTime/1000+step}).catch(()=>{});
 });
 }catch(e:any){if(v===version && e.name!=='AbortError')error.value="图表初始化失败："+String(e.message || e);}finally{if(v===version)fetching.value=false;}
}
async function focusEvent(event:any){
 const v=version,request=++focusEpoch;
 try {
  const [chain,ca,pairId]=props.symbol.split(':');const data=await get(`/api/backtests/${props.runId}/locate`,{chain,ca,pairId,eventId:event.id,...filters()});if(v!==version || request!==focusEpoch)return;focused=data;const mountingVersion=version+1;await mountChart();if(request===focusEpoch && version===mountingVersion && data.eventId===event.id)selectEvent(event);
 } catch { if(v===version && request===focusEpoch)error.value="图表尚未完成加载，稍后再点击事件定位"; }
}
defineExpose({focusEvent});
onMounted(mountChart);watch(()=>[props.symbol,props.interval,props.runId,props.anchor],()=>{focused=undefined;void mountChart();});onBeforeUnmount(reset);
watch(()=>[props.includeEndOfBacktest,props.signalTypes],async()=>{
 reset();fib.value=undefined;focused=undefined;const v=version;
 if(!props.runId)return;const [chain,ca,pairId]=props.symbol.split(':');
 try{const data=await get(`/api/backtests/${props.runId}/locate`,{chain,ca,pairId,tradeId:props.anchor?.tradeId,...filters()});if(v!==version)return;focused=data;await mountChart();}catch(e:any){if(v===version&&e.name!=='AbortError')error.value='筛选点位加载失败，请重新选择交易';}
});
watch(showFib,()=>{if(ready)void drawFib(widget.activeChart(),version).catch(()=>{error.value='Fib 绘图失败，请重新加载';});});
watch(fibView,()=>{if(!ready)return;const a=focused ?? props.anchor;if(!a||a.empty)return;const full=fibView.value==='full'&&a.fib?.status==='available';const from=full?a.fibFrom:a.from,to=full?a.fibTo:a.to;if(from!=null&&to!=null)void widget.activeChart().setVisibleRange({from:from/1000,to:to/1000+(seconds[props.interval]||30)}).catch(()=>{error.value='视野切换失败，请重新加载';});});
</script>
<template><p v-if="missingMarkers" class="event-detail" role="status">{{missingMarkers}} 个可见区间事件对应 K 线缺失或尚未加载，未绘制点位；事件列表仍可查看。</p><div v-if="fib" class="measurement"><a-radio-group v-model:value="fibView" size="small"><a-radio-button value="full">完整 Fib</a-radio-button><a-radio-button value="trade">买卖区间</a-radio-button></a-radio-group><a-switch v-model:checked="showFib" size="small" :disabled="fib.status!=='available'" /> 显示 Fib <span>0 = 高点 · 1 = 低点 · 时间 UTC</span></div><a-alert v-if="error" :message="error" type="warning" show-icon><template #action><a-button @click="mountChart">重新加载</a-button></template></a-alert><div class="measurement"><template v-if="selectedBuy"><strong>{{selectedBuy.event_label || '买入'}} {{displayValue(Number(selectedBuy.price))}}</strong><span>光标{{isMcap?'市值':'价格'}}：{{cursorValue==null?'—':displayValue(cursorValue)}}</span><strong :class="valueTone(movement)">{{movement==null?'移动鼠标查看涨跌幅':signedValue(movement)+'%'}}</strong><span>不含交易成本</span><a-button size="small" @click="clearSelection">取消选择</a-button></template><span v-else>点击买入或加仓标记，再移动鼠标或长按拖动图表，比较光标{{isMcap?'市值':'价格'}}与该买入点的涨跌幅。</span></div><p v-if="selectedEvent" class="event-detail"><a-tooltip :title="JSON.stringify(selectedEvent.reason_json)">{{eventSummary(selectedEvent)}} ⓘ</a-tooltip></p><div ref="container" class="tv-chart" /><FibAudit :fib="fib" :is-mcap="isMcap" /></template>
<style scoped>.measurement{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:40px;color:#43544d}.positive{color:#176b5b}.negative{color:#b42318}.event-detail{overflow-wrap:anywhere;color:#43544d}.tv-chart{height:580px;width:100%;background:#fff;border:1px solid #dfe6e3;border-radius:8px;overflow:hidden}</style>
