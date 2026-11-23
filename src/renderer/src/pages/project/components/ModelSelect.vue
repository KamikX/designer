<script setup lang="ts">
import { t } from '@renderer/i18n'
import { useProviderStore } from '@renderer/stores/provider'
import { useChatStore } from '@renderer/stores/chat'
import { isChoiceAlive } from '@renderer/stores/selection'

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
    chatStore.selectModel(providerId, modelId)
  }
})

/**
 * 兜底选第一个可用模型。
 *
 * 判据是"当前选择还在不在列表里",不是"选没选过"——项目存档里的模型
 * 完全可能已经被删掉或停用了。只判空的话,那种情况下选择器会显示成一个
 * 认不出的空值,而且发出去必然报错。
 *
 * 兜底结果**不写回存档**(persist=false):供应商可能只是临时停用,回头
 * 启用了这个项目还该是用户原来选的那个。
 */
watchEffect(() => {
  const groups = providerStore.chatModels
  // 还没加载完就别动——此刻列表为空不代表用户的选择失效了
  if (groups.length === 0) return

  if (isChoiceAlive(chatStore.selected, groups)) return

  const group = groups[0]
  chatStore.selectModel(group.provider.id, group.models[0].id, false)
})
</script>

<template>
  <a-select
    v-model:value="value"
    :options="options"
    size="small"
    class="model-select"
    style="min-width: 128px; max-width: 200px"
    :placeholder="t('选择模型')"
    variant="borderless"
    :popup-match-select-width="false"
  />
</template>

<style scoped>
.model-select :deep(.ant-select-selector) {
  font-size: 12px;
}
</style>
