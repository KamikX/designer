<script setup lang="ts">
import { App } from 'antdv-next'
import { CheckSquareOutlined, CloseOutlined, DeleteOutlined } from '@antdv-next/icons'
import { t, uiMessage } from '@renderer/i18n'
import { useChatStore } from '@renderer/stores/chat'
import MessageItem from './MessageItem.vue'

const emit = defineEmits<{ openDiff: [artifactId: string] }>()

const chat = useChatStore()
const { modal, message } = App.useApp()
const selecting = ref(false)
const selected = ref<string[]>([])
const busy = computed(() => chat.streaming || chat.sending || chat.deleting)
const allSelected = computed(() => selected.value.length === chat.messages.length)
let revision = 0

watch(
  () => chat.conversationId,
  () => {
    revision++
    selecting.value = false
    selected.value = []
  },
  { flush: 'sync' }
)

onBeforeUnmount(() => {
  revision++
})

function toggle(id: string): void {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((value) => value !== id)
    : [...selected.value, id]
}

function cancel(): void {
  selecting.value = false
  selected.value = []
}

function remove(ids: string[]): void {
  if (busy.value || !ids.length) return
  const conversationId = chat.conversationId
  const currentRevision = revision
  modal.confirm({
    title: t('chatMessages.confirm', ids.length),
    content: t('chatMessages.explanation'),
    okText: t('chatMessages.delete'),
    cancelText: t('common.cancel'),
    okType: 'danger',
    onOk: async () => {
      // A confirmation opened in another conversation must never act on this one.
      if (currentRevision !== revision || conversationId !== chat.conversationId) return
      try {
        await chat.deleteMessages(conversationId, ids)
        if (currentRevision === revision) cancel()
      } catch (error) {
        void message.error(uiMessage(error instanceof Error ? error.message : String(error)))
        throw error
      }
    }
  })
}
</script>

<template>
  <div v-if="chat.messages.length" class="message-history">
    <div class="history-actions" :class="{ 'history-actions--selecting': selecting }">
      <template v-if="selecting">
        <div class="history-selection-content">
          <div class="history-selection">
            <a-checkbox
              :checked="allSelected"
              :indeterminate="selected.length > 0 && !allSelected"
              :disabled="busy"
              @change="selected = allSelected ? [] : chat.messages.map((item) => item.id)"
              >{{ t('chatMessages.selectAll') }}</a-checkbox
            >
            <span class="history-count" aria-live="polite">{{
              t('chatMessages.selected', selected.length)
            }}</span>
          </div>
          <div class="history-selection-actions">
            <a-button
              type="text"
              size="small"
              danger
              :disabled="busy || !selected.length"
              :loading="chat.deleting"
              @click="remove([...selected])"
            >
              <template #icon><DeleteOutlined /></template>
              {{ t('chatMessages.delete') }}
            </a-button>
          </div>
        </div>
        <a-tooltip :title="t('common.cancel')">
          <a-button
            class="history-icon history-cancel"
            type="text"
            size="small"
            :aria-label="t('common.cancel')"
            :disabled="chat.deleting"
            @click="cancel"
          >
            <template #icon><CloseOutlined /></template>
          </a-button>
        </a-tooltip>
      </template>
      <a-tooltip v-else :title="t('chatMessages.select')">
        <a-button
          class="history-icon"
          type="text"
          size="small"
          :aria-label="t('chatMessages.select')"
          :disabled="busy"
          @click="selecting = true"
        >
          <template #icon><CheckSquareOutlined /></template>
        </a-button>
      </a-tooltip>
    </div>
    <div v-for="item in chat.messages" :key="item.id" class="history-row">
      <a-checkbox
        v-if="selecting"
        class="history-check"
        :checked="selected.includes(item.id)"
        :disabled="busy"
        :aria-label="t('chatMessages.selectOne')"
        @change="toggle(item.id)"
      />
      <MessageItem
        :message="item"
        :delete-disabled="busy"
        @delete="remove([item.id])"
        @open-diff="emit('openDiff', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.message-history {
  container-type: inline-size;
}
.history-actions {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px 8px;
  margin-bottom: 4px;
  font-size: 12px;
}
.history-actions--selecting {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  padding: 4px 8px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-soft);
  border-radius: var(--radius);
}
.history-selection-content,
.history-selection,
.history-selection-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 8px;
  min-width: 0;
}
.history-selection-actions {
  justify-content: flex-end;
  margin-left: auto;
}
.history-count,
.history-icon {
  color: var(--text-muted);
}
.history-icon:hover:not(:disabled) {
  color: var(--text);
  background: var(--fill-subtle);
}
.history-icon:focus-visible {
  outline: 2px solid var(--text-muted);
  outline-offset: 2px;
}
@container (max-width: 380px) {
  .history-selection,
  .history-selection-actions {
    width: 100%;
    justify-content: center;
  }
  .history-selection-actions {
    margin-left: 0;
  }
}
.history-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.history-check {
  margin-top: 10px;
}
.history-row > .message {
  flex: 1;
  min-width: 0;
}
</style>
