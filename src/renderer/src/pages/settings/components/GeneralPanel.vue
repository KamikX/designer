<script setup lang="ts">
import { t } from '@renderer/i18n'
import { App } from 'antdv-next'
import { useAppConfig } from '@renderer/components/config/config'
import { DEFAULT_TOOL_CALL_LIMIT } from '@shared/limits'
import AssistantModelField from './AssistantModelField.vue'
import type { ReasoningEffort } from '@shared/types'

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

/**
 * 单轮工具调用上限。同样是"敲一半无效"的东西,显式保存。
 *
 * 老配置文件里没这个键,读到 undefined 时用默认值兜底——不能让输入框
 * 空着,那看起来像"没有上限"。
 */
const toolCallLimit = ref<number>(window.api.initialConfig.toolCallLimit ?? DEFAULT_TOOL_CALL_LIMIT)

/**
 * 推理档位。离散选择,选完即存(没有"敲一半"的中间态)。
 * off = 不发送任何推理参数,与旧版本行为一致。
 */
const reasoningEffort = ref<ReasoningEffort>(window.api.initialConfig.reasoningEffort ?? 'off')
const reasoningOptions = computed(() => [
  { label: t('common.off'), value: 'off' },
  { label: t('common.low'), value: 'low' },
  { label: t('common.medium'), value: 'medium' },
  { label: t('common.high'), value: 'high' }
])

onMounted(async () => {
  // initialConfig 是 preload 启动时取的快照,别的窗口可能改过,进面板时读一次新的
  const config = await window.api.config.read()
  marketUrl.value = config.marketUrl
  toolCallLimit.value = config.toolCallLimit ?? DEFAULT_TOOL_CALL_LIMIT
  reasoningEffort.value = config.reasoningEffort ?? 'off'
})

async function saveReasoningEffort(): Promise<void> {
  await window.api.config.patch({ reasoningEffort: reasoningEffort.value })
  message.success(
    reasoningEffort.value === 'off'
      ? t('messages.reasoningDisabledForTheNextTurn')
      : t('messages.savedForTheNextTurn')
  )
}

async function saveToolCallLimit(): Promise<void> {
  const value = Math.max(0, Math.floor(Number(toolCallLimit.value) || 0))
  toolCallLimit.value = value
  await window.api.config.patch({ toolCallLimit: value })
  message.success(
    value === 0 ? t('messages.unlimitedCallsFromTheNextTurn') : t('messages.savedLimitCalls', value)
  )
}

async function saveMarketUrl(): Promise<void> {
  const url = marketUrl.value.trim()
  if (url && !/^https?:\/\//.test(url)) {
    message.warning(t('messages.theMarketplaceUrlMustStartWithHttpOrHttps'))
    return
  }
  await window.api.config.patch({ marketUrl: url })
  message.success(
    url
      ? t('messages.savedTheMarketplaceWillLoadTheRemoteCatalog')
      : t('messages.clearedTheMarketplaceIsEmpty')
  )
}
</script>

<template>
  <div style="max-width: 560px">
    <a-form layout="vertical">
      <a-form-item :label="t('common.language')">
        <a-segmented v-model:value="lang" :options="langOptions" />
      </a-form-item>
      <a-form-item :label="t('common.appearance')">
        <a-switch
          v-model:checked="dark"
          :checked-children="t('common.dark')"
          :un-checked-children="t('common.light')"
        />
      </a-form-item>
      <a-form-item :label="t('common.themeColor')">
        <a-color-picker
          v-model:value="primaryColor"
          value-format="hex"
          :presets="colorPresets"
          :disabled-alpha="true"
          show-text
        />
      </a-form-item>
      <a-button @click="resetTheme">{{ t('common.resetTheme') }}</a-button>

      <a-divider />
      <a-form-item :label="t('common.marketplaceUrl')">
        <a-space-compact block>
          <a-input
            v-model:value="marketUrl"
            :placeholder="t('messages.httpsExampleComMarketJsonLeaveEmptyForNoMarketplace')"
            @press-enter="saveMarketUrl"
          />
          <a-button type="primary" @click="saveMarketUrl">{{ t('common.save') }}</a-button>
        </a-space-compact>
        <div style="font-size: 12px; margin-top: 6px; opacity: 0.55">
          {{ t('messages.pointToAJsonEndpointTheMarketplaceWillLoadItsCatalogAutomatically') }}
          <code>{ "skills": [...], "mcp": [...] }</code>
        </div>
      </a-form-item>

      <a-divider />
      <a-form-item :label="t('messages.toolCallLimitPerTurn')">
        <a-space-compact>
          <a-input-number
            v-model:value="toolCallLimit"
            :min="0"
            :step="10"
            :precision="0"
            style="width: 140px"
            @press-enter="saveToolCallLimit"
          />
          <a-button type="primary" @click="saveToolCallLimit">{{ t('common.save') }}</a-button>
        </a-space-compact>
        <div style="font-size: 12px; margin-top: 6px; opacity: 0.55">
          {{ t('messages.maximumToolCallsPerTurnMore') }}
        </div>
      </a-form-item>

      <a-divider />
      <a-form-item :label="t('common.reasoningEffort')">
        <a-segmented
          v-model:value="reasoningEffort"
          :options="reasoningOptions"
          @change="saveReasoningEffort"
        />
        <div style="font-size: 12px; margin-top: 6px; opacity: 0.55">
          {{ t('messages.letTheModelReasonBeforeActing') }}
        </div>
      </a-form-item>

      <a-divider />
      <AssistantModelField />
    </a-form>
  </div>
</template>
