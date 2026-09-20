<script setup lang="ts">
import { ref } from 'vue';
import { message, Modal } from 'ant-design-vue';
import { api } from '../api';
const props=defineProps<{run:any}>();const emit=defineEmits(['changed']);
const busy=ref('');let rerunRequest:string|undefined;
async function perform(action:string){
 if(busy.value)return;
 if(action==='stop' || action==='rerun' || (action==='retry' && !props.run.checkpoint_at)){
 const ok=await new Promise<boolean>(resolve=>Modal.confirm({title:action==='stop'?'停止并保留检查点？':action==='rerun'?'创建新任务从头回测？':'该任务尚无检查点，将从头开始',content:action==='stop'?'执行器会在安全边界保存进度；之后可点击重试继续。':action==='rerun'?'旧任务和结果不会改变，新任务重新冻结行情。':'已冻结完成的输入仍保留。',okText:'确认',cancelText:'取消',onOk:()=>resolve(true),onCancel:()=>resolve(false)}));if(!ok)return;
 }
 busy.value=action;
 try{if(action==='rerun')rerunRequest ||= crypto.randomUUID();const {data}=await api.post(`/backtests/${props.run.id}/${action}`,action==='rerun'?{requestId:rerunRequest}:{});if(action==='rerun')rerunRequest=undefined;message.success(action==='stop'?'已提交停止请求':action==='retry'?'已提交断点重试':'已创建新回测任务');emit('changed',data);}
 catch(e:any){message.error(e.response?.data?.message || '操作失败，请重试');}finally{busy.value='';}
}
</script>
<template><a-space wrap @click.stop><a-button v-if="run.actions?.stop" size="small" :loading="busy==='stop'" :disabled="!!busy" @click="perform('stop')">停止</a-button><a-button v-if="run.actions?.retry" size="small" :loading="busy==='retry'" :disabled="!!busy" @click="perform('retry')">重试 · 继续</a-button><a-button size="small" :loading="busy==='rerun'" :disabled="!!busy" @click="perform('rerun')">重新回测</a-button><span v-if="run.status==='stopping'" role="status">正在保存检查点…</span></a-space></template>
