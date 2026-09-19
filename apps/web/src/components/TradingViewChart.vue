<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
const props = defineProps<{ symbol: string; interval: string; runId?: string }>();
const container = ref<HTMLDivElement>(); let widget: any;
const resolutions: Record<string,string> = { "30s":"30S", "1m":"1", "5m":"5", "15m":"15", "1h":"60", "4h":"240", "1d":"D" };
async function mountChart() {
  if (!container.value) return;
  try {
    const tv = (window as any).TradingView;
    if (!tv) throw new Error("TradingView bundle is not installed");
    widget = new tv.widget({ container: container.value, library_path: "/charting_library/", symbol: props.symbol, interval: resolutions[props.interval] || "30S", timezone: "Etc/UTC", theme: "Light", autosize: true, datafeed: { onReady: (cb:any) => cb({ supported_resolutions: ["30S","1","5","15","60","240","D"] }), resolveSymbol: (_s:any, cb:any) => fetch(`/api/tv/symbols?symbol=${encodeURIComponent(props.symbol)}`).then(r => r.json()).then(cb), getBars: (_info:any, resolution:string, range:any, onResult:any, onError:any) => fetch(`/api/tv/history?symbol=${encodeURIComponent(props.symbol)}&resolution=${resolution}&from=${range.from}&to=${range.to}`).then(r => r.json()).then(x => onResult(x.t ? x.t.map((t:number,i:number) => ({ time:t*1000, open:x.o[i],high:x.h[i],low:x.l[i],close:x.c[i],volume:x.v[i] })) : [], { noData: !x.t })).catch(onError), searchSymbols: (_i:any,_e:any,_t:any,_r:any,cb:any) => cb([]) } });
    widget.onChartReady(() => { if (props.runId) loadMarkers(); });
  } catch { if (container.value) container.value.innerHTML = "<div class='chart-fallback'>请将 TradingView charting_library 放入 apps/web/public/charting_library 后加载图表</div>"; }
}
async function loadMarkers() { const [chain,,pairId] = props.symbol.split(":"); const markers = await fetch(`/api/backtests/${props.runId}/signals`).then(r => r.json()).catch(() => []); for (const marker of markers.filter((item:any) => item.chain === chain && item.pair_id === pairId)) widget?.activeChart()?.createShape({ time: Number(marker.time) / 1000, price: Number(marker.price) }, { shape: marker.signal_type === "entry" || marker.signal_type === "add" ? "arrow_up" : "arrow_down", text: marker.signal_type, lock: true, disableSelection: true }); }
onMounted(mountChart); watch(() => [props.symbol, props.interval, props.runId], () => { widget?.remove(); mountChart(); }); onBeforeUnmount(() => widget?.remove());
</script>
<template><div ref="container" class="tv-chart" /></template>
<style scoped>.tv-chart{height:620px;width:100%;background:#fff;border:1px solid #e2e9e6;border-radius:8px;overflow:hidden}.chart-fallback{padding:24px;color:#66736f}</style>
