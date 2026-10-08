<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {message} from 'ant-design-vue';
import {CopyOutlined,ReloadOutlined} from '@ant-design/icons-vue';
import {projectKey,shortCa} from '../project-identity';
import {useProjectDirectory} from '../composables/useProjectDirectory';
const props=withDefaults(defineProps<{chain:string;ca:string;full?:boolean;compact?:boolean;selectable?:boolean;disabled?:boolean}>(),{full:false,compact:false,selectable:false,disabled:false});
const emit=defineEmits<{select:[]}>();
const directory=useProjectDirectory(),imageFailed=ref(false);
const entry=computed(()=>directory.entries[projectKey(props)]);
const label=computed(()=>entry.value?.symbol||'未知项目');
watch(()=>[props.chain,props.ca,directory.epoch.value],()=>{imageFailed.value=false;directory.ensure([props]);},{immediate:true});
watch(()=>entry.value?.logoUrl,()=>imageFailed.value=false);
async function copy(){
 try{
  if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(props.ca);
  else{const focused=document.activeElement as HTMLElement|null,el=document.createElement('textarea');el.value=props.ca;el.style.position='fixed';el.style.opacity='0';document.body.append(el);try{el.select();if(!document.execCommand('copy'))throw new Error('copy');}finally{el.remove();focused?.focus({preventScroll:true});}}
  message.success('已复制完整 CA');
 }catch{message.error('复制失败，请从地址提示中手动复制');}
}
</script>
<template>
 <span class="project-identity" :class="{'is-full':full,'is-compact':compact}" :aria-busy="entry?.status==='loading'">
  <component :is="selectable?'button':'span'" class="project-main" :class="{'is-selectable':selectable}" :disabled="selectable?disabled:undefined" :type="selectable?'button':undefined" @click="selectable&&emit('select')">
   <img v-if="entry?.logoUrl&&!imageFailed" class="project-logo" :src="entry.logoUrl" alt="" loading="lazy" referrerpolicy="no-referrer" @error="imageFailed=true" />
   <span v-else class="project-logo project-placeholder" aria-hidden="true">{{label==='未知项目'?'?':Array.from(label)[0].toUpperCase()}}</span>
   <span class="project-text"><span class="project-name" :title="label"><span v-if="entry?.status==='loading'" class="project-skeleton" aria-label="正在加载项目资料" /><strong v-else>{{label}}</strong><small>{{chain.toUpperCase()}}</small></span><span class="project-ca" :title="ca">{{full?ca:shortCa(ca)}}</span></span>
  </component>
  <button type="button" class="project-icon" :aria-label="`复制完整 CA ${ca}`" title="复制完整 CA" @click.stop="copy"><CopyOutlined /></button>
  <button v-if="entry?.status==='error'" type="button" class="project-icon" aria-label="重试项目资料" title="项目资料加载失败，点击重试" @click.stop="directory.retry(props)"><ReloadOutlined /></button>
 </span>
</template>
<style scoped>
.project-identity{display:inline-flex;align-items:center;gap:4px;max-width:100%;min-width:0;vertical-align:middle}.project-main{display:inline-flex;align-items:center;gap:8px;min-width:0;max-width:100%;text-align:left;color:#18211f;background:none;border:0;padding:0;font:inherit}.project-logo{width:24px;height:24px;flex:0 0 24px;border-radius:50%;object-fit:cover;background:#edf2ef}.project-placeholder{display:grid;place-items:center;font-size:12px;color:#43544d;border:1px solid #dce5e0}.project-text{display:flex;flex-direction:column;min-width:0;gap:2px}.project-name{display:flex;align-items:center;gap:6px;min-width:0}.project-name strong{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}.project-name small{font-size:10px;color:#53635e;flex:none}.project-ca{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;color:#53635e;overflow-wrap:anywhere}.project-icon{display:inline-flex;align-items:center;justify-content:center;flex:0 0 28px;width:28px;height:28px;background:none;border:0;border-radius:4px;color:#53635e;cursor:pointer;padding:0}.project-icon:hover{background:#e8f2ef;color:#176b5b}.project-icon:focus-visible,.is-selectable:focus-visible{outline:2px solid #176b5b;outline-offset:2px}.is-selectable{cursor:pointer}.is-selectable:hover .project-ca{color:#176b5b;text-decoration:underline}.is-selectable:disabled{cursor:default;opacity:.6}.project-skeleton{width:64px;height:12px;border-radius:3px;background:#e3eae6}.is-full .project-text{max-width:100%}.is-compact .project-text{flex-direction:row;align-items:center;gap:8px}.is-compact .project-name strong{max-width:120px}.is-compact .project-ca{white-space:nowrap}@media(max-width:680px){.is-compact .project-text{flex-wrap:wrap;gap:2px 8px}.project-name strong{max-width:140px}.project-main{flex:1;min-width:0}.project-icon{width:32px;height:32px;flex-basis:32px}}
</style>
