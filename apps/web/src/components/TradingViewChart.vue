<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { eventLabels as labels, marketValue, changePercent } from '../format';
const props=defineProps<{symbol:string;interval:string;runId?:string;startTime?:number|null;endTime?:number|null;includeEndOfBacktest?:boolean;anchor?:{from?:number;to?:number;start?:number;end?:number;empty?:boolean}}>();
const selectedBuy=ref<any>(),cursorValue=ref<number>(),selectedEvent=ref<any>();
const isMcap=computed(()=>props.symbol.endsWith(':mcap'));
const movement=computed(()=>changePercent(cursorValue.value!,Number(selectedBuy.value?.price)));
const displayValue=(n:number)=>isMcap.value?marketValue(n):Number(n).toLocaleString('en-US',{maximumSignificantDigits:10});
let ready=false,referenceId:any,referenceEpoch=0;
const markMap=new Map<string,any>(),shapeMap=new Map<any,any>();
const fetching=ref(false);let focused:any,focusEpoch=0;
const container=ref<HTMLDivElement>(),error=ref("");let widget:any,version=0,markerVersion=0;
let controller=new AbortController(),rangeTimer:number|undefined;
const resolutions:Record<string,string>={"30s":"30S","1m":"1","5m":"5","15m":"15","1h":"60","4h":"240","1d":"D"};
const seconds:Record<string,number>={"30s":30,"1m":60,"5m":300,"15m":900,"1h":3600,"4h":14400,"1d":86400};
const markText=(m:any)=>`${m.event_label ?? ''} ${labels[m.signal_type] || m.signal_type} · ${isMcap.value?"市值":"价格"} ${displayValue(Number(m.price))} · 数量 ${m.quantity ?? "不可用"}${props.includeEndOfBacktest===false && m.excluded_end?' · 不计入当前统计':''}\n${JSON.stringify(m.reason_json)}`;
const eventSummary=(m:any)=>`${m.event_label ?? ''} ${labels[m.signal_type] || m.signal_type} · ${new Date(Number(m.time)).toLocaleString()} · ${isMcap.value?'市值':'价格'} ${displayValue(Number(m.price))} · 数量 ${m.quantity==null?'不可用':Number(m.quantity).toLocaleString('zh-CN',{maximumSignificantDigits:8})} · ${m.reason_json?.message || labels[m.reason_json?.priority] || '策略条件满足'}${props.includeEndOfBacktest===false && m.excluded_end?' · 不计入当前统计':''}`;
function clearSelection(){selectedBuy.value=undefined;selectedEvent.value=undefined;cursorValue.value=undefined;referenceEpoch++;if(referenceId&&ready)try{widget.activeChart().removeEntity(referenceId);}catch{}referenceId=undefined;}
async function drawReference(){
 if(!ready||!selectedBuy.value)return;const request=++referenceEpoch,chart=widget.activeChart();
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
  const data=await get(`/api/backtests/${props.runId}/signals`,{chain,ca,pairId,from:Math.floor(from*1000),to:Math.ceil(to*1000),page,pageSize:500});
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
  const data=await get(`/api/backtests/${props.runId}/signals`,{chain,ca,pairId,from:Math.floor(range.from*1000),to:Math.ceil(range.to*1000),page,pageSize:500});
  if(v!==version || mv!==markerVersion)return;markers.push(...data.items);
  if(page*500>=data.total)break;
 }
 for(const id of shapeMap.keys())try{chart.removeEntity(id);}catch{}shapeMap.clear();
 for(const marker of markers){
  if(v!==version || mv!==markerVersion)return;
  const text=marker.event_label || labels[marker.signal_type] || marker.signal_type;
  const id=await chart.createShape({time:Number(marker.time)/1000,price:Number(marker.price)},{shape:marker.signal_type==="risk_event"?"flag":["entry","add"].includes(marker.signal_type)?"arrow_up":"arrow_down",text,lock:true,disableSave:true,disableUndo:true,overrides:{color:marker.signal_type==="risk_event"?"#b7791f":["entry","add"].includes(marker.signal_type)?"#176b5b":"#c2413b"}});
  if(v!==version || mv!==markerVersion) { try { chart.removeEntity(id); } catch {} return; }
  shapeMap.set(id,marker);markMap.set(String(marker.id),marker);
 }
 }catch(e:any){if(v===version && e.name!=="AbortError")error.value="事件标注加载失败，可切换交易池重试";}
}
function reset(){clearSelection();ready=false;version++;markerVersion++;controller.abort();controller=new AbortController();window.clearTimeout(rangeTimer);widget?.remove();widget=undefined;shapeMap.clear();markMap.clear();}
async function mountChart(){
 reset();const v=version,symbol=props.symbol,step=seconds[props.interval] || 30;error.value="";
 if(!container.value)return;
 const tv=(window as any).TradingView;
 if(!tv){error.value="未找到 TradingView charting_library，请检查本地组件资源";return;}
 try{
 const anchor=focused ?? props.anchor;
 const initial:any[]=[];
 if(anchor && !anchor.empty && anchor.from!==undefined){
  fetching.value=true;let to=Math.floor(anchor.to/1000)+step;
  for(;;){const x=await get('/api/tv/history',{symbol,resolution:resolutions[props.interval],runId:props.runId,from:Math.floor(anchor.from/1000),to});if(v!==version)return;if(!x.t?.length)break;
   initial.unshift(...x.t.map((t:number,i:number)=>({time:t*1000,open:x.o[i],high:x.h[i],low:x.l[i],close:x.c[i],volume:x.v[i]})));
   if(x.t.length<5000 || x.t[0]*1000<=anchor.from)break;to=x.t[0];
  }
  if(!initial.length)error.value='买卖点附近缺少原始 K 线，无法显示对应行情；不会补造。';
  else if([anchor.start,anchor.end].some(t=>t!==undefined && !initial.some(b=>b.time===t)))error.value='部分事件对应原始 K 线缺失；保留事件记录，不补造行情。';
  fetching.value=false;
 }
 const localWidget=new tv.widget({container:container.value,library_path:"/charting_library/",symbol,interval:resolutions[props.interval],timezone:"Etc/UTC",theme:"Light",autosize:true,
 enabled_features:['two_character_bar_marks_labels'],
 custom_formatters:{priceFormatterFactory:()=>isMcap.value?{format:(value:number)=>marketValue(value)}:null},
 disabled_features:["header_symbol_search","header_resolutions","header_compare","timeframes_toolbar","use_localstorage_for_settings","legend_inplace_edit","symbol_search_hot_key","show_interval_dialog_on_key_press"],
 datafeed:{
  onReady:(cb:any)=>setTimeout(()=>cb({supported_resolutions:[resolutions[props.interval]],supports_time:false,supports_marks:true}),0),
  getMarks:(_info:any,from:number,to:number,cb:any)=>{
   if(!props.runId){cb([]);return;}
   markerRows(from,to).then(items=>{if(v!==version)return;items.forEach(m=>markMap.set(String(m.id),m));cb(items.map(m=>({id:m.id,time:Number(m.time)/1000,color:m.signal_type==="risk_event"?"yellow":["entry","add"].includes(m.signal_type)?"green":"red",text:markText(m).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"),label:m.event_label || (m.signal_type==="risk_event"?"!":m.signal_type==="entry"?"买":m.signal_type==="add"?"加":"卖"),labelFontColor:"white",minSize:28})));}).catch(()=>{if(v===version)cb([]);});
  },
  resolveSymbol:(_s:any,cb:any,onError:any)=>get("/api/tv/symbols",{symbol}).then(data=>{if(v===version)cb({...data,supported_resolutions:[resolutions[props.interval]]});}).catch(onError),
  getBars:(_info:any,_resolution:string,range:any,onResult:any,onError:any)=>{
   if(range.firstDataRequest && anchor && !anchor.empty){setTimeout(()=>{if(v===version)onResult(initial,{noData:!initial.length});},0);return;}
   let from=range.from,to=range.to;
   if(range.firstDataRequest && props.endTime!==null && props.endTime!==undefined){to=Math.floor(props.endTime/1000)+step;from=to-step*Math.max(300,range.countBack || 300);}
   get("/api/tv/history",{symbol,resolution:resolutions[props.interval],runId:props.runId,from,to,countBack:Math.min(5000,Math.max(range.countBack || 300,Math.ceil((to-from)/step)))})
   .then(x=>{if(v!==version)return;onResult(x.t?x.t.map((t:number,i:number)=>({time:t*1000,open:x.o[i],high:x.h[i],low:x.l[i],close:x.c[i],volume:x.v[i]})):[],{noData:!x.t});})
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
  chart.onVisibleRangeChanged().subscribe(null,()=>{window.clearTimeout(rangeTimer);rangeTimer=window.setTimeout(()=>loadMarkers(chart,v),200);});
  loadMarkers(chart,v);
  if(anchor && !anchor.empty)chart.setVisibleRange({from:anchor.from/1000,to:anchor.to/1000+step}).then(()=>loadMarkers(chart,v)).catch(()=>{});
  else if(props.endTime!==null && props.endTime!==undefined)chart.setVisibleRange({from:Math.max((props.startTime ?? 0)/1000,props.endTime/1000-step*200),to:props.endTime/1000+step}).catch(()=>{});
 });
 }catch(e:any){if(v===version && e.name!=='AbortError')error.value="图表初始化失败："+String(e.message || e);}finally{if(v===version)fetching.value=false;}
}
async function focusEvent(event:any){
 const v=version,request=++focusEpoch;
 try {
  const [chain,ca,pairId]=props.symbol.split(':');const data=await get(`/api/backtests/${props.runId}/locate`,{chain,ca,pairId,eventId:event.id});if(v!==version || request!==focusEpoch)return;focused=data;const mountingVersion=version+1;await mountChart();if(request===focusEpoch && version===mountingVersion)selectEvent(event);
 } catch { error.value="图表尚未完成加载，稍后再点击事件定位"; }
}
defineExpose({focusEvent});
onMounted(mountChart);watch(()=>[props.symbol,props.interval,props.runId,props.anchor],()=>{focused=undefined;void mountChart();});onBeforeUnmount(reset);
watch(()=>props.includeEndOfBacktest,()=>{if(ready)widget.activeChart().refreshMarks();});
</script>
<template><a-alert v-if="error" :message="error" type="warning" show-icon><template #action><a-button @click="mountChart">重新加载</a-button></template></a-alert><div class="measurement"><template v-if="selectedBuy"><strong>{{selectedBuy.event_label || '买入'}} {{displayValue(Number(selectedBuy.price))}}</strong><span>光标{{isMcap?'市值':'价格'}}：{{cursorValue==null?'—':displayValue(cursorValue)}}</span><strong :class="movement!=null&&movement<0?'negative':'positive'">{{movement==null?'移动鼠标查看涨跌幅':(movement>=0?'+':'')+movement.toFixed(2)+'%'}}</strong><span>不含交易成本</span><a-button size="small" @click="clearSelection">取消选择</a-button></template><span v-else>点击买入或加仓标记，再移动鼠标，比较光标{{isMcap?'市值':'价格'}}与该买入点的涨跌幅。</span></div><p v-if="selectedEvent" class="event-detail"><a-tooltip :title="JSON.stringify(selectedEvent.reason_json)">{{eventSummary(selectedEvent)}} ⓘ</a-tooltip></p><div ref="container" class="tv-chart" /></template>
<style scoped>.measurement{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:40px;color:#43544d}.positive{color:#176b5b}.negative{color:#b42318}.event-detail{overflow-wrap:anywhere;color:#43544d}.tv-chart{height:580px;width:100%;background:#fff;border:1px solid #dfe6e3;border-radius:8px;overflow:hidden}</style>
