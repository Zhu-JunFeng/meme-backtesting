<script setup lang="ts">
import { signedValue, valueTone, formatNumber } from '../format';
defineProps<{value:unknown;percent?:boolean;adverse?:boolean}>();
</script>
<template><span :class="valueTone(value,adverse)">{{adverse?formatNumber(value):signedValue(value)}}{{value!=null&&percent?'%':''}}</span></template>
