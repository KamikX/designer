<script setup lang="ts">
import { useProviderStore } from '@renderer/stores/provider'
import { useChatStore } from '@renderer/stores/chat'

/**
 * 模型选择器。value 形如 `${providerId}:${modelRowId}`,选择结果写进
 * chat store,发送时直接取用。默认选第一个可用模型。
 */

const providerStore = useProviderStore()
const chatStore = useChatStore()
providerStore.load()

const options = computed(() =>
  providerStore.chatModels.map(({ provider, models }) => ({
    label: provider.name,
    options: models.map((m) => ({ label: m.displayName, value: `${provider.id}:${m.id}` }))
  }))
)

const value = computed<string | undefined>({
  get: () =>
    chatStore.selected
      ? `${chatStore.selected.providerId}:${chatStore.selected.modelId}`
      : undefined,
  set: (v) => {
    if (!v) return
    const [providerId, modelId] = v.split(':')
    chatStore.selected = { providerId, modelId }
  }
})

// 首次进入时自动选第一个可用模型;没有任何可用模型时保持空,由外层提示
watchEffect(() => {
  if (!chatStore.selected && providerStore.chatModels.length > 0) {
    const group = providerStore.chatModels[0]
    chatStore.selected = { providerId: group.provider.id, modelId: group.models[0].id }
  }
})
</script>

<template>
  <a-select
    v-model:value="value"
    :options="options"
    size="small"
    class="model-select"
    style="min-width: 150px; max-width: 220px"
    placeholder="选择模型"
    variant="borderless"
    :popup-match-select-width="false"
  />
</template>

<style scoped>
.model-select :deep(.ant-select-selector) {
  font-size: 12px;
}
</style>
