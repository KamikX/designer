<script setup lang="ts">
import { useAppConfig } from '@renderer/components/config/config'

const { lang, dark, langOptions } = useAppConfig()
</script>

<template>
  <a-space vertical :size="16" style="padding: 16px">
    <a-space>
      <a-segmented v-model:value="lang" :options="langOptions" />
      <a-switch v-model:checked="dark" checked-children="暗" un-checked-children="亮" />
    </a-space>
    <a-space wrap>
      <a-date-picker />
      <a-range-picker />
    </a-space>
    <a-pagination :default-current="1" :total="50" show-size-changer />
  </a-space>
</template>
