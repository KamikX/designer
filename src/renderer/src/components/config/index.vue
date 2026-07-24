<script setup lang="ts">
import { App as AntdApp, ConfigProvider } from 'antdv-next'
import { useAppConfig, PROVIDER_OPTIONS } from './config'

/**
 * 全局配置壳：ConfigProvider + App。
 *
 * 本身不接受任何 props —— 要改配置去 ./config.ts。
 * App 必须是 ConfigProvider 的子级，否则 useApp() 拿到的
 * message / modal / notification 读不到主题 token。
 */
const { antdLocale, themeConfig } = useAppConfig()
</script>

<template>
  <ConfigProvider v-bind="PROVIDER_OPTIONS" :locale="antdLocale" :theme="themeConfig">
    <AntdApp>
      <slot />
    </AntdApp>
  </ConfigProvider>
</template>
