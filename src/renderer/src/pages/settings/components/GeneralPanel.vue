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
  { label: t('关'), value: 'off' },
  { label: t('低'), value: 'low' },
  { label: t('中'), value: 'medium' },
  { label: t('高'), value: 'high' }
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
    reasoningEffort.value === 'off' ? t('已关闭推理,下一轮对话生效') : t('已保存,下一轮对话生效')
  )
}

async function saveToolCallLimit(): Promise<void> {
  const value = Math.max(0, Math.floor(Number(toolCallLimit.value) || 0))
  toolCallLimit.value = value
  await window.api.config.patch({ toolCallLimit: value })
  message.success(value === 0 ? t('已设为不限次数,下一轮对话生效') : t('已保存,上限 {0} 次', value))
}

async function saveMarketUrl(): Promise<void> {
  const url = marketUrl.value.trim()
  if (url && !/^https?:\/\//.test(url)) {
    message.warning(t('市场地址需要以 http:// 或 https:// 开头'))
    return
  }
  await window.api.config.patch({ marketUrl: url })
  message.success(url ? t('已保存,市场页会自动加载远程清单') : t('已清空,市场为空'))
}
</script>

<template>
  <div style="max-width: 560px">
    <a-form layout="vertical">
      <a-form-item :label="t('语言')">
        <a-segmented v-model:value="lang" :options="langOptions" />
      </a-form-item>
      <a-form-item :label="t('外观')">
        <a-switch
          v-model:checked="dark"
          :checked-children="t('暗')"
          :un-checked-children="t('亮')"
        />
      </a-form-item>
      <a-form-item :label="t('主题色')">
        <a-color-picker
          v-model:value="primaryColor"
          value-format="hex"
          :presets="colorPresets"
          :disabled-alpha="true"
          show-text
        />
      </a-form-item>
      <a-button @click="resetTheme">{{ t('重置主题') }}</a-button>

      <a-divider />
      <a-form-item :label="t('应用市场地址')">
        <a-space-compact block>
          <a-input
            v-model:value="marketUrl"
            :placeholder="t('https://example.com/market.json,留空则市场为空')"
            @press-enter="saveMarketUrl"
          />
          <a-button type="primary" @click="saveMarketUrl">{{ t('保存') }}</a-button>
        </a-space-compact>
        <div style="font-size: 12px; margin-top: 6px; opacity: 0.55">
          {{ t('指向一个 JSON 端点，配置后市场页自动加载远程清单。') }}
          <code>{ "skills": [...], "mcp": [...] }</code>
        </div>
      </a-form-item>

      <a-divider />
      <a-form-item :label="t('单轮工具调用上限')">
        <a-space-compact>
          <a-input-number
            v-model:value="toolCallLimit"
            :min="0"
            :step="10"
            :precision="0"
            style="width: 140px"
            @press-enter="saveToolCallLimit"
          />
          <a-button type="primary" @click="saveToolCallLimit">{{ t('保存') }}</a-button>
        </a-space-compact>
        <div style="font-size: 12px; margin-top: 6px; opacity: 0.55">
          {{
            t(
              'AI 在一轮里最多调用多少次工具。改动越复杂需要的次数越多；0 = 不限，单轮会更慢更贵。单个项目可以在工作台里另设。'
            )
          }}
        </div>
      </a-form-item>

      <a-divider />
      <a-form-item :label="t('推理档位')">
        <a-segmented
          v-model:value="reasoningEffort"
          :options="reasoningOptions"
          @change="saveReasoningEffort"
        />
        <div style="font-size: 12px; margin-top: 6px; opacity: 0.55">
          {{
            t(
              '让模型在动手前先思考，每轮可能更慢、更贵。按供应商自动映射；DeepSeek 与自定义中转不受影响。'
            )
          }}
        </div>
      </a-form-item>

      <a-divider />
      <AssistantModelField />
    </a-form>
  </div>
</template>
