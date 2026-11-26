<script setup lang="ts">
import { useCodeEdits } from '@renderer/composables/useCodeEdits'
import { DownOutlined } from '@antdv-next/icons'
import { t } from '@renderer/i18n'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useChatStore } from '@renderer/stores/chat'

const props = defineProps<{ projectId: string }>()
const store = useArtifactStore()
const chat = useChatStore()
const open = ref(false)
const { confirmEdits } = useCodeEdits()
const busy = computed(
  () =>
    store.loading ||
    store.saving ||
    store.streamingFiles ||
    (chat.projectId === props.projectId && chat.sending) ||
    Object.values(chat.streams).some((stream) => stream.projectId === props.projectId)
)
const historical = computed(() => store.currentId !== store.artifacts[0]?.id)

watch(busy, (value) => {
  if (value) open.value = false
})
watch(
  () => props.projectId,
  () => (open.value = false)
)

async function select(id: string): Promise<void> {
  if (busy.value || id === store.currentId) return
  open.value = false
  if (await confirmEdits()) await store.select(id)
}

function localDate(value: string): string {
  // SQLite timestamps without an offset represent UTC, not the viewer's local time.
  const normalized = value.includes('T') ? value : value.replace(' ', 'T') + 'Z'
  const date = new Date(normalized)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}
</script>

<template>
  <div v-if="store.artifacts.length" class="version-picker">
    <span v-if="historical && store.current" class="version-hint">
      {{ t('messages.nextEditStartsFromV', store.current.version) }}
    </span>
    <a-popover v-model:open="open" trigger="click" placement="bottomRight">
      <template #content>
        <div class="version-list" :aria-label="t('common.versionHistory')">
          <button
            v-for="(version, index) in store.artifacts"
            :key="version.id"
            type="button"
            class="version-option"
            :class="{ selected: version.id === store.currentId }"
            :aria-pressed="version.id === store.currentId"
            :disabled="busy"
            @click="select(version.id)"
          >
            <span class="version-meta">
              <strong>v{{ version.version }}</strong>
              <span v-if="index === 0">{{ t('common.latest') }}</span>
              <time :datetime="version.createdAt">{{ localDate(version.createdAt) }}</time>
            </span>
            <span v-if="version.summary" class="version-summary" :title="version.summary">
              {{ version.summary }}
            </span>
          </button>
        </div>
      </template>
      <a-button
        size="small"
        :disabled="busy"
        :loading="store.loading"
        :aria-label="t('common.versionHistory')"
      >
        {{ t('common.versionHistory') }} {{ store.current ? `v${store.current.version}` : '' }}
        <DownOutlined />
      </a-button>
    </a-popover>
  </div>
</template>

<style scoped>
.version-picker {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  min-width: 0;
}

.version-hint {
  color: var(--text-soft);
  font-size: 12px;
}

.version-list {
  width: min(360px, 75vw);
  max-height: min(360px, 60vh);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.version-option {
  display: block;
  width: 100%;
  border: 0;
  border-radius: 6px;
  padding: 8px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.version-option:hover,
.version-option.selected {
  background: var(--bg-muted);
}

.version-option.selected {
  box-shadow: inset 2px 0 currentColor;
}

.version-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.version-meta time {
  margin-left: auto;
  color: var(--text-soft);
}

.version-summary {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 4px;
  font-size: 12px;
}
</style>
