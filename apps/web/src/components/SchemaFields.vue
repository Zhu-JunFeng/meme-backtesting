<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ modelValue: Record<string, any>; schema?: Record<string, any>; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: Record<string, any>] }>();
const fields = computed<Array<[string, any]>>(() => Object.entries(props.schema?.properties ?? {}).filter(([key]) => key !== "type") as Array<[string, any]>);

function update(key: string, value: any) {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}
const labels: Record<string,string> = { hammer:"锤子线", bullish_engulfing:"看涨吞没", pin_bar:"Pin Bar", long_lower_wick:"长下影线" };
const optionLabel = (value:any) => labels[String(value)] || String(value);
</script>

<template>
  <div class="schema-grid">
    <div v-for="([key, field]) in fields" :key="key" class="schema-field" :class="{ wide: field.type === 'array' }">
      <label>{{ field.title || key }}</label>
      <a-switch v-if="field.type === 'boolean'" :checked="Boolean(modelValue[key])" :disabled="disabled" @change="(value:any) => update(key, value)" />
      <a-select v-else-if="field.enum" :value="modelValue[key]" :disabled="disabled" style="width:100%" @change="(value:any) => update(key, value)">
        <a-select-option v-for="option in field.enum" :key="option" :value="option">{{ optionLabel(option) }}</a-select-option>
      </a-select>
      <a-checkbox-group v-else-if="field.type === 'array' && field.items?.enum" :value="modelValue[key]" :disabled="disabled" :options="field.items.enum.map((value:string) => ({ label: optionLabel(value), value }))" @change="(value:any) => update(key, value)" />
      <a-input-number v-else-if="field.type === 'number' || field.type === 'integer'" :value="modelValue[key]" :min="field.minimum" :max="field.maximum" :precision="field.type === 'integer' ? 0 : undefined" :disabled="disabled" style="width:100%" @change="(value:any) => update(key, value)" />
      <a-input v-else :value="modelValue[key]" :disabled="disabled" @change="(event:any) => update(key, event.target.value)" />
    </div>
  </div>
</template>

<style scoped>
.schema-grid{display:grid;grid-template-columns:repeat(2,minmax(140px,1fr));gap:12px 16px}.schema-field{display:flex;flex-direction:column;gap:6px}.schema-field.wide{grid-column:1/-1}.schema-field label{font-size:12px;color:#66736f;font-weight:600}.schema-field :deep(.ant-checkbox-group){display:flex;flex-wrap:wrap;gap:8px 12px}@media(max-width:720px){.schema-grid{grid-template-columns:1fr}}
</style>
