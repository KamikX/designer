<script setup lang="ts">
import { App } from 'antdv-next'
import { useAppConfig } from '@renderer/components/config/config'
import AssistantModelField from './AssistantModelField.vue'

const { lang, dark, primaryColor, langOptions, colorPresets, resetTheme } = useAppConfig()
const { message } = App.useApp()

/**
 * 应用市场源。留空 = 市场为空。指向一个 JSON 端点:
 * { "skills": [...], "mcp": [...] },两个键都可缺省。
 *
 * 单独 ref + 显式保存,不并入 useAppConfig 的自动持久化:地址是敲一半就
 * 无效的东西,每敲一个字符就写盘、市场页就跟着请求一次,不如攒到点保存。
 */
const marketUrl = ref(window.api.initialConfig.marketUrl ?? '')
onMounted(async () => {
  // initialConfig 是 preload 启动时取的快照,别的窗口可能改过,进面板时读一次新的
  marketUrl.value = (await window.api.config.read()).marketUrl
})

async function saveMarketUrl(): Promise<void> {
  const url = marketUrl.value.trim()
  if (url && !/^https?:\/\//.test(url)) {
    message.warning('市场地址需要以 http:// 或 https:// 开头')
    return
  }
  await window.api.config.patch({ marketUrl: url })
  message.success(url ? '已保存,市场页会自动加载远程清单' : '已清空,市场为空')
}
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
      <a-form-item label="应用市场地址">
        <a-space-compact block>
          <a-input
            v-model:value="marketUrl"
            placeholder="https://example.com/market.json,留空则市场为空"
            @press-enter="saveMarketUrl"
          />
          <a-button type="primary" @click="saveMarketUrl">保存</a-button>
        </a-space-compact>
        <div style="font-size: 12px; margin-top: 6px; opacity: 0.55">
          指向一个 JSON 端点:{ "skills": [...], "mcp": [...] }。配置后市场页自动加载远程清单。
        </div>
      </a-form-item>

      <a-divider />
      <AssistantModelField />
    </a-form>
  </div>
</template>
