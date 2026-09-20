<script setup lang="ts">
import { computed } from "vue";
import { CopyOutlined, DeleteOutlined, DownOutlined, PlusOutlined, UpOutlined } from "@ant-design/icons-vue";
import SchemaFields from "./SchemaFields.vue";

defineOptions({ name: "ConditionGroupEditor" });
const props = withDefaults(defineProps<{ modelValue: any; definitions: any[]; category?: string; root?: boolean }>(), { root: false });
const emit = defineEmits<{ "update:modelValue": [value: any] }>();
const available = computed(() => props.definitions.filter(definition => definition.code !== "impulse_fractal_swing" && (!props.category || definition.category === props.category || (props.category === "entry" && ["retracement","volume","candle","indicator"].includes(definition.category)))));
const definitionMap = computed(() => new Map(props.definitions.map(definition => [definition.code, definition])));
const activeCount = computed(() => props.modelValue.conditions.filter((item:any) => item.enabled !== false).length);

function patchGroup(patch: Record<string, any>) { emit("update:modelValue", { ...props.modelValue, ...patch }); }
function patchItem(index: number, item: any) { const conditions = [...props.modelValue.conditions]; conditions[index] = item; patchGroup({ conditions }); }
function addCondition(code: string) { const definition = definitionMap.value.get(code); if (!definition?.enabled) return; patchGroup({ conditions: [...props.modelValue.conditions, structuredClone(definition.defaultParameters)] }); }
function addGroup() { patchGroup({ conditions: [...props.modelValue.conditions, { mode: "all", conditions: [] }] }); }
function remove(index: number) { patchGroup({ conditions: props.modelValue.conditions.filter((_:any, itemIndex:number) => itemIndex !== index) }); }
function copy(index: number) { const conditions = [...props.modelValue.conditions]; conditions.splice(index + 1, 0, structuredClone(conditions[index])); patchGroup({ conditions }); }
function move(index: number, direction: number) { const target = index + direction; if (target < 0 || target >= props.modelValue.conditions.length) return; const conditions = [...props.modelValue.conditions]; [conditions[index], conditions[target]] = [conditions[target], conditions[index]]; patchGroup({ conditions }); }
function isGroup(item: any) { return Array.isArray(item?.conditions); }
</script>

<template>
  <div class="condition-group" :class="{ nested: !root }">
    <div class="group-toolbar">
      <div class="group-mode">
        <span>条件组</span>
        <a-segmented :value="modelValue.mode" :options="[{label:'全部满足',value:'all'},{label:'任一满足',value:'any'},{label:'至少满足',value:'at_least'}]" @change="(value:any) => patchGroup({ mode: value })" />
        <a-input-number v-if="modelValue.mode === 'at_least'" :value="modelValue.minMatches || 1" :min="1" :max="Math.max(1, activeCount)" addon-after="项" style="width:110px" @change="(value:any) => patchGroup({ minMatches: value })" />
      </div>
      <div class="add-actions">
        <a-dropdown>
          <a-button><PlusOutlined />添加条件<DownOutlined /></a-button>
          <template #overlay><a-menu @click="({key}:any) => addCondition(key)"><a-menu-item v-for="definition in available" :key="definition.code" :disabled="!definition.enabled"><div>{{ definition.name }}</div><small v-if="!definition.enabled">缺少历史数据，暂不可启用</small></a-menu-item></a-menu></template>
        </a-dropdown>
        <a-button @click="addGroup">添加子组</a-button>
      </div>
    </div>

    <a-empty v-if="!modelValue.conditions.length" :image="null" description="尚未添加条件" class="empty-group" />
    <div v-for="(item, index) in modelValue.conditions" :key="index" class="condition-item" :class="{ disabled: item.enabled === false }">
      <div class="item-head">
        <div class="item-title">
          <a-switch :checked="item.enabled !== false" size="small" @change="(value:any) => patchItem(index, {...item, enabled:value})" />
          <strong>{{ isGroup(item) ? '嵌套条件组' : (definitionMap.get(item.type)?.name || item.type) }}</strong>
          <a-tag v-if="!isGroup(item)" color="default">{{ definitionMap.get(item.type)?.category }}</a-tag>
        </div>
        <a-space size="small">
          <a-button type="text" size="small" :disabled="index===0" aria-label="上移条件" @click="move(index,-1)"><UpOutlined /></a-button>
          <a-button type="text" size="small" :disabled="index===modelValue.conditions.length-1" aria-label="下移条件" @click="move(index,1)"><DownOutlined /></a-button>
          <a-button type="text" size="small" aria-label="复制条件" @click="copy(index)"><CopyOutlined /></a-button>
          <a-button type="text" danger size="small" aria-label="删除条件" @click="remove(index)"><DeleteOutlined /></a-button>
        </a-space>
      </div>
      <ConditionGroupEditor v-if="isGroup(item)" :model-value="item" :definitions="definitions" :category="category" @update:model-value="value => patchItem(index,value)" />
      <SchemaFields v-else :model-value="item" :schema="definitionMap.get(item.type)?.parameterSchema" :disabled="item.enabled === false" @update:model-value="value => patchItem(index,value)" />
    </div>
    <div v-if="root && available.some(definition => !definition.enabled)" class="unavailable-note">链上过滤项已预置；由于缺少历史快照，当前版本不可启用。</div>
  </div>
</template>

<style scoped>
.condition-group{display:flex;flex-direction:column;gap:12px}.condition-group.nested{padding:12px;background:#f8faf9;border:1px dashed #cfd9d5;border-radius:8px}.group-toolbar,.item-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.group-mode,.add-actions,.item-title{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.group-mode>span{font-size:12px;color:#66736f;font-weight:700}.condition-item{padding:14px;border:1px solid #dfe6e3;border-radius:9px;background:#fff;display:flex;flex-direction:column;gap:14px}.condition-item.disabled{opacity:.58}.item-title strong{font-size:14px}.empty-group{padding:16px;border:1px dashed #dfe6e3;border-radius:8px}.unavailable-note{font-size:12px;color:#8a6550;background:#fff8ef;border-radius:6px;padding:8px 10px}@media(max-width:760px){.group-toolbar,.item-head{align-items:flex-start;flex-direction:column}.add-actions{width:100%}}
</style>
