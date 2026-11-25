<script setup lang="ts">
import { t } from '@renderer/i18n'
import { theme } from 'antdv-next'
import { useProviderStore } from '@renderer/stores/provider'

/**
 * 全局辅助模型。
 *
 * 长文档(需求、竞品资料、数据表)超过阈值时,先用它压成"设计要用的要点"
 * 再交给主模型。做的是信息抽取不是设计,所以挑个便宜的就行。
 *
 * 不配也能用——只是长文档会以原文形式直接进上下文,更贵也更容易被截断。
 */

const { token } = theme.useToken()
const providerStore = useProviderStore()
providerStore.load()

const config = reactive({ ...window.api.initialConfig })

const options = computed(() => [
  {
    get label() {
      return t('messages.disabledSendFullDocumentsDirectly')
    },
    value: ''
  },
  ...providerStore.chatModels.map(({ provider, models }) => ({
    label: provider.name,
    options: models.map((m) => ({ label: m.displayName, value: `${provider.id}:${m.id}` }))
  }))
])

const value = computed<string>({
  get: () =>
    config.assistantModel
      ? `${config.assistantModel.providerId}:${config.assistantModel.modelId}`
      : '',
  set: (next) => {
    // 先摊平再分两路用:从 reactive 里读回来的是响应式代理,structured clone
    // 过不去(报「An object could not be cloned」)。原始对象只能在进 reactive
    // 之前留一份,不能读 config.assistantModel
    const assistantModel = next
      ? { providerId: next.split(':')[0], modelId: next.split(':')[1] }
      : null
    config.assistantModel = assistantModel
    void window.api.config.patch({ assistantModel })
  }
})
</script>

<template>
  <a-form-item :label="t('common.assistantModel')">
    <a-select v-model:value="value" :options="options" style="max-width: 320px" />
    <div class="hint" :style="{ color: token.colorTextTertiary }">
      {{ t('messages.summarizesLongDocumentsBeforePassingThem') }}
    </div>
  </a-form-item>
</template>

<style scoped>
.hint {
  font-size: 12px;
  line-height: 1.7;
  margin-top: 4px;
}
</style>
