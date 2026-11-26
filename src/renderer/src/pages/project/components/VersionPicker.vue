<script setup lang="ts">
import { useCodeEdits } from '@renderer/composables/useCodeEdits'
import { h } from 'vue'
import { App } from 'antdv-next'
import { DeleteOutlined, DownOutlined } from '@antdv-next/icons'
import { t, uiMessage } from '@renderer/i18n'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useChatStore } from '@renderer/stores/chat'

const props = defineProps<{ projectId: string }>()
const store = useArtifactStore()
const chat = useChatStore()
const open = ref(false)
const { modal, message } = App.useApp()
const confirming = ref(false)
const { confirmEdits } = useCodeEdits()
const busy = computed(
  () =>
    store.loading ||
    store.saving ||
    store.deleting ||
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

async function remove(id: string, version: number): Promise<void> {
  if (busy.value || confirming.value || store.artifacts.length <= 1) return
  const projectId = props.projectId
  confirming.value = true
  open.value = false
  try {
    if (id === store.currentId && !(await confirmEdits())) return
    if (props.projectId !== projectId || store.projectId !== projectId || busy.value) return
    const requestId = store.requestId
    await new Promise<void>((resolve) => {
      modal.confirm({
        title: t('versions.confirmDelete', version),
        content: h(
          'div',
          { style: { maxHeight: '60vh', overflowY: 'auto', overscrollBehavior: 'contain' } },
          t('versions.irreversible')
        ),
        okText: t('common.deleteLabel'),
        cancelText: t('common.cancel'),
        okButtonProps: { danger: true },
        onCancel: () => resolve(),
        onOk: async () => {
          if (
            props.projectId !== projectId ||
            store.projectId !== projectId ||
            store.requestId !== requestId ||
            busy.value
          ) {
            resolve()
            return
          }
          try {
            await store.deleteVersion(id)
            resolve()
          } catch (error) {
            message.error(uiMessage(String(error)))
            throw error
          }
        }
      })
    })
  } finally {
    confirming.value = false
  }
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
          <div v-for="(version, index) in store.artifacts" :key="version.id" class="version-row">
            <button
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
            <a-button
              type="text"
              size="small"
              danger
              :disabled="busy || confirming || store.artifacts.length <= 1"
              :aria-label="t('versions.delete', version.version)"
              :title="
                store.artifacts.length <= 1
                  ? t('versions.keepLast')
                  : t('versions.delete', version.version)
              "
              @click.stop="remove(version.id, version.version)"
              ><DeleteOutlined
            /></a-button>
          </div>
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

.version-row {
  display: flex;
  align-items: center;
}

.version-option {
  flex: 1;
  min-width: 0;
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
