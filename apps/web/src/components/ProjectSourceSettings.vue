<script setup lang="ts">
import {PROJECT_PROVIDERS,SOURCE_WALLETS,type ProjectSources,type ProjectProvider} from '@meme/domain';
import {signalSourceOptions} from '../live-monitor';
const props=defineProps<{modelValue:ProjectSources;chain:string;disabled?:boolean}>();
const emit=defineEmits<{(e:'update:modelValue',value:ProjectSources):void}>();
const names={memeinfo:'MemeInfo 信号',wallet:'钱包买入',xxyy:'XXYY 项目列表'};
function change(p:ProjectProvider,key:string,value:unknown){
 const next=JSON.parse(JSON.stringify(props.modelValue)) as ProjectSources;
 const rule=next[p];
 if(key==='minMarketCap'&&rule.exitMarketCap===rule.minMarketCap)rule.exitMarketCap=value as number;
 Object.assign(rule,{[key]:value});emit('update:modelValue',next);
}
async function copy(value:string){await navigator.clipboard.writeText(value);}
</script>
<template>
 <div class="project-sources">
  <div class="source-choices" role="group" aria-label="项目来源，可多选">
   <a-checkbox v-for="p in PROJECT_PROVIDERS" :key="p" :checked="modelValue[p].enabled" :disabled="disabled||(p!=='memeinfo'&&chain!=='sol')" @change="change(p,'enabled',$event.target.checked)">{{names[p]}}<small v-if="p!=='memeinfo'"> · SOL</small></a-checkbox>
  </div>
  <p class="source-help">可组合来源，共享每任务 20 个 CA 名额。发现项目后仍按策略判断，不直接跟单。</p>
  <section v-for="p in PROJECT_PROVIDERS.filter(p=>modelValue[p].enabled)" :key="p" class="source-fields" :aria-label="`${names[p]}配置`">
   <h3>{{names[p]}}</h3>
   <a-form-item v-if="p==='memeinfo'" label="MemeInfo 信号类型"><a-select :value="modelValue[p].signalSources" mode="multiple" :options="signalSourceOptions" :disabled="disabled" @update:value="change(p,'signalSources',$event)" /></a-form-item>
   <div v-if="p==='wallet'" class="source-wallets"><span v-for="wallet in SOURCE_WALLETS" :key="wallet"><code>{{wallet}}</code><a-button size="small" type="link" @click="copy(wallet)">复制</a-button></span></div>
   <div class="source-grid">
    <a-form-item v-if="p!=='memeinfo'" label="项目创建不足（分钟）"><a-input-number :value="modelValue[p].maxAgeMinutes" :disabled="disabled" :min="1" :max="43200" @update:value="change(p,'maxAgeMinutes',$event)" /></a-form-item>
    <a-form-item :label="p==='memeinfo'?'入组市值至少（USD）':'入组市值大于（USD）'"><a-input-number :value="modelValue[p].minMarketCap" :disabled="disabled" :min="1" @update:value="change(p,'minMarketCap',$event)" /></a-form-item>
    <a-form-item label="低于此市值剔除（USD）" :validate-status="modelValue[p].exitMarketCap>modelValue[p].minMarketCap?'error':undefined" :help="modelValue[p].exitMarketCap>modelValue[p].minMarketCap?'剔除市值不能高于入组市值':undefined"><a-input-number :value="modelValue[p].exitMarketCap" :disabled="disabled" :min="1" :max="modelValue[p].minMarketCap" @update:value="change(p,'exitMarketCap',$event)" /></a-form-item>
    <a-form-item v-if="p==='xxyy'" label="KOL 数至少"><a-input-number :value="modelValue[p].minKol" :disabled="disabled" :min="0" :precision="0" @update:value="change(p,'minKol',$event)" /></a-form-item>
   </div>
   <p v-if="p==='xxyy'" class="source-help">固定 Pump AMM；全系统每 10 秒共享查询，返回后逐任务复核。首次查询可接收当前达标项目，剔除后再次达标可重新入组。</p>
  </section>
  <p class="source-help">已有持仓跌破门槛时仅停止买入／加仓，继续按策略卖出。多来源实际命中同一 CA 时取最低剔除门槛。</p>
 </div>
</template>
<style scoped>
.project-sources{width:100%;min-width:0}.source-choices{display:flex;gap:12px;flex-wrap:wrap}.source-choices small,.source-help{font-size:12px;color:#53615d}.source-help{margin:8px 0;line-height:1.7}.source-fields{border-top:1px solid #dfe6e3;padding-top:12px;margin-top:14px}.source-fields h3{font-size:14px;margin:0 0 12px}.source-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}.source-grid :deep(.ant-input-number){width:100%}.source-wallets{display:grid;gap:4px;margin-bottom:12px}.source-wallets span{display:flex;align-items:center;gap:4px;min-width:0}.source-wallets code{overflow-wrap:anywhere;font-size:11px}.source-wallets button{flex:none}@media(max-width:680px){.source-grid{grid-template-columns:1fr}.source-choices{flex-direction:column;gap:10px}.source-choices :deep(.ant-checkbox-wrapper){margin:0;min-height:36px;align-items:center}}
</style>
