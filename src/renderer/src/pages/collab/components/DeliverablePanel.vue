<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { App, theme } from 'antdv-next'
import { CheckCircleOutlined, ExportOutlined, FileTextOutlined } from '@antdv-next/icons'
import { useCollabStore } from '@renderer/stores/collab'

/**
 * 交付物面板。
 *
 * 群组的产出散在时间线上,同一个人返工两次就有三条,用户得自己找哪条算数
 * ——这是"整体太乱"最主要的来源。这里把它收成一张清单:谁该交什么、交了
 * 没有、点一下跳到那条消息。
 *
 * 内容一个字都不复制:清单是从 messages 派生的**视图**(shared/group-deliverables.ts),
 * 和主进程导出用的是同一份规则。
 */

const { token } = theme.useToken()
const { message } = App.useApp()
const collab = useCollabStore()

const open = ref(false)
const exporting = ref(false)

const progress = computed(() => {
  const entries = collab.deliverables
  return {
    delivered: entries.filter((e) => e.status === 'delivered').length,
    total: entries.length
  }
})

/** 跳到承载这份交付物的那条消息 */
function jump(messageId: string): void {
  const el = document.getElementById(`gmsg-${messageId}`)
  if (!el) return
  open.value = false
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

async function doExport(): Promise<void> {
  exporting.value = true
  try {
    const file = await collab.exportDeliverables()
    if (file) message.success(t('common.exportedTo', file))
  } catch (err) {
    message.error(uiMessage(err instanceof Error ? err.message : String(err)))
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <a-tooltip
    :title="progress.total ? t('messages.deliverablesForThisRound') : t('common.noDeliverablesYet')"
  >
    <button
      class="dlv-btn"
      type="button"
      :style="{ color: token.colorTextSecondary }"
      :disabled="!progress.total"
      @click="open = true"
    >
      <FileTextOutlined />
      <span class="dlv-count">{{ progress.delivered }}/{{ progress.total }}</span>
    </button>
  </a-tooltip>

  <a-drawer v-model:open="open" :title="t('messages.deliverablesForThisRound')" size="default">
    <template #extra>
      <a-button size="small" :loading="exporting" :disabled="!progress.delivered" @click="doExport">
        <template #icon><ExportOutlined /></template>
        {{ t('common.export') }}
      </a-button>
    </template>

    <div class="dlv-list">
      <button
        v-for="entry in collab.deliverables"
        :key="entry.memberId"
        class="dlv-row"
        type="button"
        :style="{ borderColor: token.colorBorderSecondary }"
        :disabled="entry.status !== 'delivered'"
        @click="jump(entry.messageId)"
      >
        <CheckCircleOutlined
          v-if="entry.status === 'delivered'"
          :style="{ color: token.colorSuccess }"
        />
        <span v-else class="dlv-dot" :style="{ borderColor: token.colorTextQuaternary }" />
        <span class="dlv-main">
          <span class="dlv-title">
            {{ entry.status === 'delivered' ? entry.title : entry.deliverable }}
          </span>
          <span class="dlv-meta" :style="{ color: token.colorTextTertiary }">
            {{ entry.memberName }}
            <template v-if="entry.status !== 'delivered'"> {{ t('common.notDelivered') }}</template>
          </span>
        </span>
      </button>
    </div>

    <div class="dlv-hint" :style="{ color: token.colorTextTertiary }">
      {{ t('messages.deliverablesFollowTheOutputsDefinedFor') }}
    </div>
  </a-drawer>
</template>

<style scoped>
.dlv-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: none;
  padding: 2px 6px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}

.dlv-btn:disabled {
  cursor: default;
  opacity: 0.45;
}

.dlv-btn:not(:disabled):hover {
  background: rgba(128, 128, 128, 0.1);
}

.dlv-count {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.dlv-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.dlv-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid;
  border-radius: 8px;
  background: none;
  color: inherit;
  cursor: pointer;
}

.dlv-row:disabled {
  cursor: default;
}

.dlv-row:not(:disabled):hover {
  background: rgba(128, 128, 128, 0.08);
}

/* 未交付用一个空心点,和已交付的对勾形成对照 */
.dlv-dot {
  width: 13px;
  height: 13px;
  border: 1px solid;
  border-radius: 50%;
  flex-shrink: 0;
}

.dlv-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dlv-title {
  font-size: 13px;
  overflow-wrap: anywhere;
}

.dlv-meta {
  font-size: 12px;
}

.dlv-hint {
  margin-top: 16px;
  font-size: 12px;
  line-height: 1.7;
}
</style>
