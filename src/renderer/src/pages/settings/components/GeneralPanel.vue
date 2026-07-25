<script setup lang="ts">
import { useAppConfig } from '@renderer/components/config/config'
import AssistantModelField from './AssistantModelField.vue'

const { lang, dark, primaryColor, langOptions, colorPresets, resetTheme } = useAppConfig()
</script>

<template>
  <div style="max-width: 560px">
    <a-form layout="vertical">
      <a-form-item label="语言">
        <a-segmented v-model:value="lang" :options="langOptions" />
      </a-form-item>
      <a-form-item label="外观">
        <a-switch v-model:checked="dark" checked-children="暗" un-checked-children="亮" />
      </a-form-item>
      <a-form-item label="主题色">
        <a-color-picker
          v-model:value="primaryColor"
          value-format="hex"
          :presets="colorPresets"
          :disabled-alpha="true"
          show-text
        />
      </a-form-item>
      <a-button @click="resetTheme">重置主题</a-button>

      <a-divider />
      <AssistantModelField />
    </a-form>
  </div>
</template>
