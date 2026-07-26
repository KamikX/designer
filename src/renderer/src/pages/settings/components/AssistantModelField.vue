<script setup lang="ts">
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
  { label: '不使用(长文档直接给原文)', value: '' },
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
    config.assistantModel = next
      ? { providerId: next.split(':')[0], modelId: next.split(':')[1] }
      : null
    void window.api.config.patch({ assistantModel: config.assistantModel })
  }
})
</script>

<template>
  <a-form-item label="辅助模型">
    <a-select v-model:value="value" :options="options" style="max-width: 320px" />
    <div class="hint" :style="{ color: token.colorTextTertiary }">
      读取长文档(pdf / docx / xlsx)时先用它提炼成设计要点再交给主模型;
      群组接力过长时的「前情纪要」也由它生成(没配则用发言成员自己的模型)。
      挑个便宜的即可——它做的是信息抽取与压缩,不是设计。
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
