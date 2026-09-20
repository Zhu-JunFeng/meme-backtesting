<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
const props=defineProps<{symbol:string;interval:string;runId?:string;startTime?:number|null;endTime?:number|null}>();
const container=ref<HTMLDivElement>(),error=ref("");let widget:any,version=0,markerVersion=0;
let controller=new AbortController(),rangeTimer:number|undefined;
const resolutions:Record<string,string>={"30s":"30S","1m":"1","5m":"5","15m":"15","1h":"60","4h":"240","1d":"D"};
const seconds:Record<string,number>={"30s":30,"1m":60,"5m":300,"15m":900,"1h":3600,"4h":14400,"1d":86400};
const labels:Record<string,string>={entry:"首次买入",add:"加仓",take_profit:"止盈卖出",stop_loss:"止损卖出",invalidation:"失效退出",timeout:"超时退出",end_of_backtest:"结束平仓",risk_event:"风险事件"};
const markText=(m:any)=>`${labels[m.signal_type] || m.signal_type} · ${props.symbol.endsWith(":mcap")?"市值":"价格"} ${m.price} · 数量 ${m.quantity ?? "不可用"}\n${JSON.stringify(m.reason_json)}`;
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
 chart.removeAllShapes();
 for(const marker of markers){
  if(v!==version || mv!==markerVersion)return;
  const text=labels[marker.signal_type] || marker.signal_type;
  const id=await chart.createShape({time:Number(marker.time)/1000,price:Number(marker.price)},{shape:marker.signal_type==="risk_event"?"flag":["entry","add"].includes(marker.signal_type)?"arrow_up":"arrow_down",text,lock:true,disableSave:true,disableUndo:true,overrides:{color:marker.signal_type==="risk_event"?"#b7791f":["entry","add"].includes(marker.signal_type)?"#176b5b":"#c2413b"}});
  if(v!==version || mv!==markerVersion) { try { chart.removeEntity(id); } catch {} return; }
 }
 }catch(e:any){if(v===version && e.name!=="AbortError")error.value="事件标注加载失败，可切换交易池重试";}
}
function reset(){version++;markerVersion++;controller.abort();controller=new AbortController();window.clearTimeout(rangeTimer);widget?.remove();widget=undefined;}
function mountChart(){
 reset();const v=version,symbol=props.symbol,step=seconds[props.interval] || 30;error.value="";
 if(!container.value)return;
 const tv=(window as any).TradingView;
 if(!tv){error.value="未找到 TradingView charting_library，请检查本地组件资源";return;}
 try{
 const localWidget=new tv.widget({container:container.value,library_path:"/charting_library/",symbol,interval:resolutions[props.interval],timezone:"Etc/UTC",theme:"Light",autosize:true,
 disabled_features:["header_symbol_search","header_resolutions","header_compare","timeframes_toolbar","use_localstorage_for_settings","legend_inplace_edit","symbol_search_hot_key","show_interval_dialog_on_key_press"],
 datafeed:{
  onReady:(cb:any)=>setTimeout(()=>cb({supported_resolutions:[resolutions[props.interval]],supports_time:false,supports_marks:true}),0),
  getMarks:(_info:any,from:number,to:number,cb:any)=>{
   if(!props.runId){cb([]);return;}
   markerRows(from,to).then(items=>{if(v!==version)return;cb(items.map(m=>({id:m.id,time:Number(m.time)/1000,color:m.signal_type==="risk_event"?"yellow":["entry","add"].includes(m.signal_type)?"green":"red",text:markText(m).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"),label:m.signal_type==="risk_event"?"!":m.signal_type==="entry"?"买":m.signal_type==="add"?"加":"卖",labelFontColor:"white",minSize:20})));}).catch(()=>{if(v===version)cb([]);});
  },
  resolveSymbol:(_s:any,cb:any,onError:any)=>get("/api/tv/symbols",{symbol}).then(data=>{if(v===version)cb({...data,supported_resolutions:[resolutions[props.interval]]});}).catch(onError),
  getBars:(_info:any,_resolution:string,range:any,onResult:any,onError:any)=>{
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
  if(v!==version)return;const chart=localWidget.activeChart();
  chart.onVisibleRangeChanged().subscribe(null,()=>{window.clearTimeout(rangeTimer);rangeTimer=window.setTimeout(()=>loadMarkers(chart,v),200);});
  loadMarkers(chart,v);
  if(props.endTime!==null && props.endTime!==undefined)chart.setVisibleRange({from:Math.max((props.startTime ?? 0)/1000,props.endTime/1000-step*200),to:props.endTime/1000+step}).catch(()=>{});
 });
 }catch(e:any){error.value="图表初始化失败："+String(e.message || e);}
}
async function focusEvent(event:any){
 if(!widget)return;const chart=widget.activeChart(),step=seconds[props.interval] || 30;
 try {
  await chart.setVisibleRange({from:Number(event.time)/1000-step*30,to:Number(event.time)/1000+step*30});
  await loadMarkers(chart,version);
 } catch { error.value="图表尚未完成加载，稍后再点击事件定位"; }
}
defineExpose({focusEvent});
onMounted(mountChart);watch(()=>[props.symbol,props.interval,props.runId],mountChart);onBeforeUnmount(reset);
</script>
<template><a-alert v-if="error" :message="error" type="warning" show-icon><template #action><a-button @click="mountChart">重新加载</a-button></template></a-alert><div ref="container" class="tv-chart" /></template>
<style scoped>.tv-chart{height:580px;width:100%;background:#fff;border:1px solid #dfe6e3;border-radius:8px;overflow:hidden}</style>
