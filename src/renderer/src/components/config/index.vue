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
    <!-- ConfigProvider 只做 provide 不渲染 DOM，但 App 会渲染一个没有高度的
         div，高度链会在这里断掉，所以要显式把它撑满 -->
    <AntdApp class="h-full">
      <slot />
    </AntdApp>
  </ConfigProvider>
</template>
