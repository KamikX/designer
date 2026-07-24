<script setup lang="ts">
import { theme } from 'antdv-next'
import { useAppConfig } from '@renderer/components/config/config'

const { token } = theme.useToken()
const { lang, dark, primaryColor, langOptions, colorPresets, resetTheme } = useAppConfig()
</script>

<template>
  <a-card title="设置" :style="{ background: token.colorBgContainer }">
    <template #extra>
      <a-button size="small" @click="resetTheme">重置主题</a-button>
    </template>

    <a-descriptions :column="1" bordered size="small">
      <a-descriptions-item label="语言">
        <a-segmented v-model:value="lang" :options="langOptions" size="small" />
      </a-descriptions-item>
      <a-descriptions-item label="外观">
        <a-switch
          v-model:checked="dark"
          checked-children="暗"
          un-checked-children="亮"
          size="small"
        />
      </a-descriptions-item>
      <a-descriptions-item label="主题色">
        <a-color-picker
          v-model:value="primaryColor"
          size="small"
          value-format="hex"
          :presets="colorPresets"
          :disabled-alpha="true"
          show-text
        />
      </a-descriptions-item>
    </a-descriptions>
  </a-card>
</template>
