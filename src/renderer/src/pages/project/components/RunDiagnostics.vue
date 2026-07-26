<script setup lang="ts">
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
    { label: '总耗时', value: fmtMs(ms(run.startedAt, run.endedAt)) },
    { label: '首个输出', value: fmtMs(ms(run.startedAt, run.firstOutputAt)) },
    { label: '首个文件变化', value: fmtMs(ms(run.startedAt, run.firstFileChangeAt)) },
    { label: '模型请求', value: `${run.modelCallCount} 次` },
    { label: '工具调用', value: `${run.toolCallCount} 次` },
    { label: '工具失败', value: `${run.toolFailureCount} 次` }
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
  return value == null ? '未报告' : value.toLocaleString()
}

const STATUS_TEXT: Record<string, string> = {
  running: '进行中',
  complete: '完成',
  error: '出错',
  aborted: '已停止',
  interrupted: '被应用重启打断',
  pending: '未返回',
  success: '成功',
  recoverable_error: '可恢复失败',
  fatal_error: '失败'
}

function toolDuration(tool: RunDiagnostics['tools'][number]): string {
  return fmtMs(ms(tool.execStartedAt, tool.execCompletedAt))
}
</script>

<template>
  <a-drawer :open="open" title="运行诊断" size="large" @close="emit('close')">
    <a-spin v-if="loading" />
    <a-empty v-else-if="!data" description="没有诊断数据(明细只保留 7 天)" />
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
        <a-tag v-if="data.run.toolBreaker" color="warning">触发工具次数熔断</a-tag>
        <a-tag v-if="data.run.tokenBreaker" color="warning">触发 token 熔断</a-tag>
        <a-tag v-if="data.run.errorBreaker" color="warning">触发错误熔断</a-tag>
      </div>

      <div class="diag-section-title" :style="{ color: token.colorTextTertiary }">
        模型请求({{ data.steps.length }} 步)
      </div>
      <div class="diag-list">
        <div
          v-for="step in data.steps"
          :key="step.callId"
          class="diag-row"
          :style="{ borderColor: token.colorBorderSecondary }"
        >
          <div class="diag-row-head">
            <span>第 {{ step.stepNumber + 1 }} 步 · {{ step.modelId }}</span>
            <span :style="{ color: token.colorTextTertiary }">
              {{ fmtMs(step.stepTimeMs) }}
              <template
                v-if="slowestStep && step.callId === slowestStep.callId && data.steps.length > 1"
              >
                · 最慢
              </template>
            </span>
          </div>
          <div class="diag-row-detail" :style="{ color: token.colorTextTertiary }">
            首包 {{ fmtMs(step.timeToFirstOutputMs) }} · 输入 {{ fmtTokens(step.inputTokens) }} ·
            缓存读 {{ fmtTokens(step.cacheReadTokens) }} · 缓存写
            {{ fmtTokens(step.cacheWriteTokens) }} · 输出 {{ fmtTokens(step.outputTokens) }} · 思考
            {{ fmtTokens(step.reasoningTokens) }}
          </div>
          <div v-if="step.errorCode" class="diag-row-detail" :style="{ color: token.colorError }">
            {{ STATUS_TEXT[step.status] ?? step.status }} · {{ step.errorCode }}
          </div>
        </div>
      </div>

      <div class="diag-section-title" :style="{ color: token.colorTextTertiary }">
        工具时间线({{ data.tools.length }} 次)
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
              {{ STATUS_TEXT[tool.status] ?? tool.status }} · 执行 {{ toolDuration(tool) }}
            </span>
          </div>
          <div
            v-if="tool.errorSummary"
            class="diag-row-detail"
            :style="{
              color: tool.status === 'fatal_error' ? token.colorError : token.colorWarning
            }"
          >
            {{ tool.errorCode }} {{ tool.errorSummary }}
            <template v-if="tool.recovered">(已恢复)</template>
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
