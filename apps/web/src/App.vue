<script setup lang="ts">
import { computed, ref } from "vue";
import { ExperimentOutlined, FundOutlined,PlayCircleOutlined, SafetyCertificateOutlined } from "@ant-design/icons-vue";
import StrategyWorkspace from "./components/StrategyWorkspace.vue";
import BacktestWorkspace from "./components/BacktestWorkspace.vue";
import LiveWorkspace from "./components/LiveWorkspace.vue";
import './responsive.css';

const page = ref<"backtest"|"strategy"|"paper"|"live">("backtest");
const pageTitle = computed(() => ({strategy:"策略配置",backtest:"回测工作台",paper:"模拟盘",live:"实盘"})[page.value]);
const pageDescription = computed(() => ({strategy:"定义指标、组合规则，并保存不可变策略版本",backtest:"选择策略版本与历史 K 线数据集，执行并复核回测结果",paper:"用实时信号和成交回放策略，记录模拟成交与权益",live:"绑定专用钱包、核对硬性限额后管理真实交易"})[page.value]);
</script>

<template>
  <a-config-provider :theme="{ token: { colorPrimary:'#176b5b',colorInfo:'#376a9f',colorSuccess:'#2f7d5b',colorWarning:'#b7791f',colorError:'#c2413b',borderRadius:8,fontFamily:'Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif' } }">
    <div class="app-shell">
      <aside class="side-nav">
        <div class="brand"><div class="brand-mark">M</div><div><strong>Meme Lab</strong><span>Backtesting</span></div></div>
        <nav aria-label="主导航">
          <button :class="{active:page==='backtest'}" :aria-current="page==='backtest'?'page':undefined" @click="page='backtest'"><FundOutlined /><span>回测工作台</span></button>
          <button :class="{active:page==='strategy'}" :aria-current="page==='strategy'?'page':undefined" @click="page='strategy'"><ExperimentOutlined /><span>策略配置</span></button>
          <button :class="{active:page==='paper'}" :aria-current="page==='paper'?'page':undefined" @click="page='paper'"><PlayCircleOutlined /><span>模拟盘</span></button>
          <button :class="{active:page==='live'}" :aria-current="page==='live'?'page':undefined" @click="page='live'"><SafetyCertificateOutlined /><span>实盘</span></button>
        </nav>
        <div class="environment"><i></i><div><span>数据服务</span><strong>已连接</strong></div></div>
      </aside>
      <main>
        <header class="page-header"><div><h1>{{ pageTitle }}</h1><p>{{ pageDescription }}</p></div><div class="scope-badge">{{ page==='paper'||page==='live'?'实时成交 · 30s/1m · 北京时间 UTC+8':'历史 K 线 · 单周期 · 北京时间 UTC+8' }}</div></header>
        <BacktestWorkspace v-if="page==='backtest'" />
        <StrategyWorkspace v-else-if="page==='strategy'" />
        <LiveWorkspace v-else :key="page" :mode="page" />
      </main>
    </div>
  </a-config-provider>
</template>

<style>
*{box-sizing:border-box}html,body,#app{margin:0;min-height:100%;background:#f4f6f8;color:#18211f;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.app-shell{min-height:100vh;display:grid;grid-template-columns:216px minmax(0,1fr)}.side-nav{position:sticky;top:0;height:100vh;background:#17201e;color:#dce7e3;padding:22px 14px;display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:11px;padding:0 7px 24px}.brand-mark{width:34px;height:34px;border-radius:8px;background:#d5ebe4;color:#174e43;display:grid;place-items:center;font-weight:850;font-size:18px}.brand strong,.brand span{display:block}.brand strong{font-size:15px;color:#f1f6f4}.brand span{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#85958f;margin-top:2px}.side-nav nav{display:flex;flex-direction:column;gap:5px}.side-nav nav button{display:flex;align-items:center;gap:10px;width:100%;border:0;background:transparent;color:#9fb0aa;padding:11px 12px;border-radius:7px;text-align:left;cursor:pointer;font-size:14px}.side-nav nav button:hover{color:#f1f6f4;background:#212c29}.side-nav nav button.active{background:#293c37;color:#e3f2ed}.environment{margin-top:auto;border-top:1px solid #2d3936;padding:18px 8px 2px;display:flex;align-items:center;gap:9px}.environment i{width:8px;height:8px;border-radius:50%;background:#55b98e;box-shadow:0 0 0 3px rgba(85,185,142,.12)}.environment span,.environment strong{display:block;font-size:11px}.environment span{color:#82928d}.environment strong{color:#c8d6d1;margin-top:2px}main{min-width:0;padding:24px}.page-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.page-header h1{font-size:22px;letter-spacing:-.02em;margin:0;color:#18211f}.page-header p{margin:5px 0 0;color:#66736f;font-size:13px}.scope-badge{font-size:12px;color:#53615d;border:1px solid #d7dfdc;border-radius:999px;padding:7px 11px;background:#fff;font-weight:600}@media(max-width:900px){.app-shell{display:block}.side-nav{position:static;height:auto;padding:12px 16px;flex-direction:row;align-items:center;gap:15px}.brand{padding:0}.brand span,.environment{display:none}.side-nav nav{flex-direction:row;margin-left:auto}.side-nav nav button span{display:none}.side-nav nav button{padding:10px 13px}.app-shell main{padding:18px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
</style>
