<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { theme } from 'antdv-next'
import type { RunDiagnostics } from '@shared/types'

/**
 * 单条 assistant 消息的运行诊断抽屉。
 *
 * 数据是主进程 SQLite 里的七天明细,**打开时才拉**——消息列表滚动不预取,
 * 超出窗口的老消息拿到 null,显示"已超出 7 天诊断窗口"。
 */

const props = defineProps<{ messageId: string; open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { token } = theme.useToken()

const loading = ref(false)
const data = ref<RunDiagnostics | null>(null)
const fetched = ref(false)

watch(
  () => props.open,
  async (open) => {
    if (!open || fetched.value) return
    loading.value = true
    try {
      data.value = await window.api.observability.runForMessage(props.messageId)
      fetched.value = true
    } finally {
      loading.value = false
    }
  },
  { immediate: true }
)

function ms(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  const delta = Date.parse(to) - Date.parse(from)
  return Number.isFinite(delta) && delta >= 0 ? delta : null
}

const runStats = computed(() => {
  const run = data.value?.run
  if (!run) return []
  return [
    {
      get label() {
        return t('common.totalDuration')
      },
      value: fmtMs(ms(run.startedAt, run.endedAt))
    },
    {
      get label() {
        return t('common.firstOutput')
      },
      value: fmtMs(ms(run.startedAt, run.firstOutputAt))
    },
    {
      get label() {
        return t('common.firstFileChange')
      },
      value: fmtMs(ms(run.startedAt, run.firstFileChangeAt))
    },
    {
      get label() {
        return t('common.modelRequests')
      },
      value: t('common.calls', run.modelCallCount)
    },
    {
      get label() {
        return t('common.toolCalls')
      },
      value: t('common.calls', run.toolCallCount)
    },
    {
      get label() {
        return t('common.toolFailures')
      },
      value: t('common.calls', run.toolFailureCount)
    }
  ]
})

/** 最慢的一步,让"为什么这轮慢"一眼可见 */
const slowestStep = computed(() => {
  const steps = data.value?.steps ?? []
  return steps.reduce(
    (max, s) => (s.stepTimeMs != null && s.stepTimeMs > (max?.stepTimeMs ?? -1) ? s : max),
    null as (typeof steps)[number] | null
  )
})

function fmtMs(value: number | null): string {
  if (value == null) return '—'
  return value >= 10_000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`
}

/** 未报告的 token 字段显示"未报告",绝不显示 0 */
function fmtTokens(value: number | null): string {
  return value == null ? t('common.notReported') : value.toLocaleString()
}

const STATUS_TEXT: Record<string, string> = {
  get running() {
    return t('common.inProgress')
  },
  get complete() {
    return t('common.complete')
  },
  get error() {
    return t('common.error')
  },
  get aborted() {
    return t('common.stopped')
  },
  get interrupted() {
    return t('messages.interruptedByApplicationRestart')
  },
  get pending() {
    return t('common.noResponse')
  },
  get success() {
    return t('common.success')
  },
  get recoverable_error() {
    return t('common.recoverableFailure')
  },
  get fatal_error() {
    return t('common.failed')
  }
}

function toolDuration(tool: RunDiagnostics['tools'][number]): string {
  return fmtMs(ms(tool.execStartedAt, tool.execCompletedAt))
}
</script>

<template>
  <a-drawer :open="open" :title="t('common.runDiagnostics')" size="large" @close="emit('close')">
    <a-spin v-if="loading" />
    <a-empty
      v-else-if="!data"
      :description="t('messages.noDiagnosticDataDetailsAreKeptFor7Days')"
    />
    <div v-else class="diag">
      <div class="diag-grid">
        <div v-for="item in runStats" :key="item.label" class="diag-stat">
          <div class="diag-stat-label" :style="{ color: token.colorTextTertiary }">
            {{ item.label }}
          </div>
          <div class="diag-stat-value">{{ item.value }}</div>
        </div>
      </div>

      <div v-if="data.run.toolBreaker || data.run.tokenBreaker || data.run.errorBreaker">
        <a-tag v-if="data.run.toolBreaker" color="warning">{{
          t('messages.toolCallLimitReached')
        }}</a-tag>
        <a-tag v-if="data.run.tokenBreaker" color="warning">{{
          t('common.tokenLimitReached')
        }}</a-tag>
        <a-tag v-if="data.run.errorBreaker" color="warning">{{
          t('common.errorLimitReached')
        }}</a-tag>
      </div>

      <div class="diag-section-title" :style="{ color: token.colorTextTertiary }">
        {{ t('common.modelRequestsLabel') }}{{ data.steps.length }} {{ t('common.steps') }}
      </div>
      <div class="diag-list">
        <div
          v-for="step in data.steps"
          :key="step.callId"
          class="diag-row"
          :style="{ borderColor: token.colorBorderSecondary }"
        >
          <div class="diag-row-head">
            <span
              >{{ t('common.step') }} {{ step.stepNumber + 1 }}
              {{ t('common.languageChineseLabel') }} {{ step.modelId }}</span
            >
            <span :style="{ color: token.colorTextTertiary }">
              {{ fmtMs(step.stepTimeMs) }}
              <template
                v-if="slowestStep && step.callId === slowestStep.callId && data.steps.length > 1"
              >
                {{ t('common.slowest') }}
              </template>
            </span>
          </div>
          <div class="diag-row-detail" :style="{ color: token.colorTextTertiary }">
            {{ t('common.firstChunk') }} {{ fmtMs(step.timeToFirstOutputMs) }}
            {{ t('common.input') }} {{ fmtTokens(step.inputTokens) }} {{ t('common.cacheRead') }}
            {{ fmtTokens(step.cacheReadTokens) }} {{ t('common.cacheWrite') }}
            {{ fmtTokens(step.cacheWriteTokens) }} {{ t('common.output') }}
            {{ fmtTokens(step.outputTokens) }} {{ t('common.reasoning') }}
            {{ fmtTokens(step.reasoningTokens) }}
          </div>
          <div v-if="step.errorCode" class="diag-row-detail" :style="{ color: token.colorError }">
            {{ STATUS_TEXT[step.status] ?? step.status }} · {{ step.errorCode }}
          </div>
        </div>
      </div>

      <div class="diag-section-title" :style="{ color: token.colorTextTertiary }">
        {{ t('common.toolTimeline') }}{{ data.tools.length }} {{ t('common.callsLabel') }}
      </div>
      <div class="diag-list">
        <div
          v-for="tool in data.tools"
          :key="tool.callId"
          class="diag-row"
          :style="{ borderColor: token.colorBorderSecondary }"
        >
          <div class="diag-row-head">
            <span>
              {{ tool.toolName }}
              <template v-if="tool.targetSummary"> · {{ tool.targetSummary }}</template>
            </span>
            <span
              :style="{
                color:
                  tool.status === 'fatal_error'
                    ? token.colorError
                    : tool.status === 'recoverable_error'
                      ? token.colorWarning
                      : token.colorTextTertiary
              }"
            >
              {{ STATUS_TEXT[tool.status] ?? tool.status }} {{ t('common.execution') }}
              {{ toolDuration(tool) }}
            </span>
          </div>
          <div
            v-if="tool.errorSummary"
            class="diag-row-detail"
            :style="{
              color: tool.status === 'fatal_error' ? token.colorError : token.colorWarning
            }"
          >
            {{ tool.errorCode }} {{ uiMessage(tool.errorSummary) }}
            <template v-if="tool.recovered">{{ t('common.recovered') }}</template>
          </div>
        </div>
      </div>
    </div>
  </a-drawer>
</template>

<style scoped>
.diag {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
}

.diag-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}

.diag-stat-label {
  font-size: 12px;
}

.diag-stat-value {
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

.diag-section-title {
  font-size: 12px;
  margin-top: 4px;
}

.diag-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 明细可能几十行,自己封顶滚动,别把抽屉顶出滚动条 */
  max-height: 320px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.diag-row {
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 6px 10px;
}

.diag-row-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.diag-row-detail {
  font-size: 12px;
  margin-top: 2px;
  overflow-wrap: anywhere;
}
</style>
