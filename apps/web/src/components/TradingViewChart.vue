<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
const props = defineProps<{ symbol: string; interval: string; runId?: string }>();
const container = ref<HTMLDivElement>(); let widget: any;
async function mountChart() {
  if (!container.value) return;
  try {
    const tv = (window as any).TradingView;
    if (!tv) throw new Error("TradingView bundle is not installed");
    widget = new tv.widget({ container: container.value, library_path: "/charting_library/", symbol: props.symbol, interval: props.interval === "30s" ? "30S" : props.interval, timezone: "Etc/UTC", theme: "Dark", autosize: true, datafeed: { onReady: (cb:any) => cb({ supported_resolutions: ["30S","1","5","15","60","240","D"] }), resolveSymbol: (_s:any, cb:any) => fetch(`/api/tv/symbols?symbol=${encodeURIComponent(props.symbol)}`).then(r => r.json()).then(cb), getBars: (info:any, _resolution:any, range:any, onResult:any, onError:any) => fetch(`/api/tv/history?symbol=${encodeURIComponent(props.symbol)}&resolution=${props.interval === "30s" ? "30S" : props.interval}&from=${range.from}&to=${range.to}`).then(r => r.json()).then(x => onResult(x.t ? x.t.map((t:number,i:number) => ({ time:t*1000, open:x.o[i],high:x.h[i],low:x.l[i],close:x.c[i],volume:x.v[i] })) : [], { noData: !x.t })).catch(onError), searchSymbols: (_i:any,_e:any,_t:any,_r:any,cb:any) => cb([]) } });
    if (props.runId) loadMarkers();
  } catch { if (container.value) container.value.innerHTML = "<div class='chart-fallback'>请将 TradingView charting_library 放入 apps/web/public/charting_library 后加载图表</div>"; }
}
async function loadMarkers() { const markers = await fetch(`/api/backtests/${props.runId}/signals`).then(r => r.json()).catch(() => []); for (const marker of markers) widget?.activeChart()?.createShape({ time: marker.time / 1000, price: Number(marker.price) }, { shape: marker.signal_type === "entry" || marker.signal_type === "add" ? "arrow_up" : "arrow_down", text: marker.signal_type, lock: true, disableSelection: true }); }
onMounted(mountChart); watch(() => [props.symbol, props.interval, props.runId], () => { widget?.remove(); mountChart(); }); onBeforeUnmount(() => widget?.remove());
</script>
<template><div ref="container" class="tv-chart" /></template>
<style scoped>.tv-chart{height:620px;width:100%;background:#111}.chart-fallback{padding:24px;color:#aaa}</style>
