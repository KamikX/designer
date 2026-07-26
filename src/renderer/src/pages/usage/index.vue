<script setup lang="ts">
import { App, theme } from 'antdv-next'
import { DeleteOutlined, ReloadOutlined } from '@antdv-next/icons'
import { cacheHitRatio, formatMetric, useUsageStore } from '@renderer/stores/usage'
import type { UsageDailyRow, UsageScene } from '@shared/types'

/**
 * 模型用量页。
 *
 * 数据是长期保留的日聚合(与七天诊断明细无关),维度:日期 × provider ×
 * model × 场景 × 项目。铁律:**未报告 ≠ 0**——provider 没报的缓存/思考
 * 字段显示"未报告",绝不用 0 冒充,否则缓存命中率就是假的。
 */

const { token } = theme.useToken()
const { modal, message } = App.useApp()
const usage = useUsageStore()

/** 快捷时间窗。规格要的是日期筛选,快捷段比日期控件少两次点击 */
const RANGES = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '全部', value: 0 }
] as const
const range = ref<number>(7)

const SCENES: { label: string; value: UsageScene | '' }[] = [
  { label: '全部场景', value: '' },
  { label: '设计', value: 'design' },
  { label: '聊天', value: 'chat' },
  { label: '群组', value: 'group' },
  { label: '辅助模型', value: 'assistant' },
  { label: '文档提炼', value: 'document_summary' },
  { label: '连通性测试', value: 'provider_test' }
]

const providerKey = ref('')
const modelId = ref('')
const scene = ref<UsageScene | ''>('')
const projectKey = ref('')

/** 下拉选项从当前数据推导,并保住已选值,避免选完选项消失 */
function optionsOf(
  pick: (row: UsageDailyRow) => string,
  current: string,
  allLabel: string
): { label: string; value: string }[] {
  const values = new Set(usage.rows.map(pick))
  if (current) values.add(current)
  return [
    { label: allLabel, value: '' },
    ...[...values].sort().map((v) => ({ label: v, value: v }))
  ]
}

const providerOptions = computed(() =>
  optionsOf((r) => r.providerSlug || r.providerKey, providerKey.value, '全部供应商')
)
const modelOptions = computed(() => optionsOf((r) => r.modelId, modelId.value, '全部模型'))
const projectOptions = computed(() => optionsOf((r) => r.projectKey, projectKey.value, '全部项目'))

function fromDate(days: number): string | undefined {
  if (!days) return undefined
  const d = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

async function reload(): Promise<void> {
  await usage.load({
    from: fromDate(range.value),
    to: undefined,
    // provider 筛选按 slug 展示但查询键是 providerKey;规范化维度里两者
    // 同名时直接可用,provider 删除后 slug 快照仍能匹配显示
    providerKey: providerKey.value || undefined,
    modelId: modelId.value || undefined,
    scene: scene.value || undefined,
    projectKey: projectKey.value || undefined
  })
}

watch([range, providerKey, modelId, scene, projectKey], () => void reload())
onMounted(() => void reload())

/** provider 筛选实际按 providerKey 匹配不了 slug 时在前端兜一层 */
const visibleRows = computed(() =>
  providerKey.value
    ? usage.rows.filter(
        (r) => r.providerSlug === providerKey.value || r.providerKey === providerKey.value
      )
    : usage.rows
)

function hitRatioText(row: UsageDailyRow): string {
  const ratio = cacheHitRatio(row)
  return ratio == null ? '未报告' : `${Math.round(ratio * 100)}%`
}

function confirmClear(): void {
  modal.confirm({
    title: '清除全部模型用量?',
    content: '长期日聚合与去重数据将一起删除,不影响消息、版本和七天诊断明细。',
    okText: '清除',
    okType: 'danger',
    onOk: async () => {
      await usage.clear()
      message.success('已清除')
    }
  })
}
</script>

<template>
  <div class="usage-page">
    <div class="usage-head">
      <h2 class="usage-title">模型用量</h2>
      <div class="usage-actions">
        <a-button size="small" @click="reload">
          <template #icon><ReloadOutlined /></template>
          刷新
        </a-button>
        <a-button size="small" danger @click="confirmClear">
          <template #icon><DeleteOutlined /></template>
          清除用量
        </a-button>
      </div>
    </div>

    <div class="usage-filters">
      <a-segmented v-model:value="range" :options="[...RANGES]" size="small" />
      <a-select
        v-model:value="providerKey"
        :options="providerOptions"
        size="small"
        style="min-width: 130px"
      />
      <a-select
        v-model:value="modelId"
        :options="modelOptions"
        size="small"
        style="min-width: 150px"
      />
      <a-select v-model:value="scene" :options="SCENES" size="small" style="min-width: 120px" />
      <a-select
        v-model:value="projectKey"
        :options="projectOptions"
        size="small"
        style="min-width: 130px"
      />
    </div>

    <div class="usage-stats">
      <div class="usage-stat" :style="{ borderColor: token.colorBorderSecondary }">
        <div class="usage-stat-label" :style="{ color: token.colorTextTertiary }">轮次</div>
        <div class="usage-stat-value">{{ usage.totals.runs.toLocaleString() }}</div>
      </div>
      <div class="usage-stat" :style="{ borderColor: token.colorBorderSecondary }">
        <div class="usage-stat-label" :style="{ color: token.colorTextTertiary }">模型请求</div>
        <div class="usage-stat-value">{{ usage.totals.steps.toLocaleString() }}</div>
      </div>
      <div class="usage-stat" :style="{ borderColor: token.colorBorderSecondary }">
        <div class="usage-stat-label" :style="{ color: token.colorTextTertiary }">输入 token</div>
        <div class="usage-stat-value">{{ usage.totals.inputTokens.toLocaleString() }}</div>
      </div>
      <div class="usage-stat" :style="{ borderColor: token.colorBorderSecondary }">
        <div class="usage-stat-label" :style="{ color: token.colorTextTertiary }">输出 token</div>
        <div class="usage-stat-value">{{ usage.totals.outputTokens.toLocaleString() }}</div>
      </div>
      <div class="usage-stat" :style="{ borderColor: token.colorBorderSecondary }">
        <div class="usage-stat-label" :style="{ color: token.colorTextTertiary }">平均每轮输入</div>
        <div class="usage-stat-value">
          {{ usage.totals.avgInputPerRun?.toLocaleString() ?? '—' }}
        </div>
      </div>
      <div class="usage-stat" :style="{ borderColor: token.colorBorderSecondary }">
        <div class="usage-stat-label" :style="{ color: token.colorTextTertiary }">
          平均每次请求输入
        </div>
        <div class="usage-stat-value">
          {{ usage.totals.avgInputPerStep?.toLocaleString() ?? '—' }}
        </div>
      </div>
    </div>

    <a-spin :spinning="usage.loading">
      <a-empty v-if="!visibleRows.length" description="这个范围内没有用量记录" />
      <div v-else class="usage-table" :style="{ borderColor: token.colorBorderSecondary }">
        <div class="usage-row usage-row--head" :style="{ color: token.colorTextTertiary }">
          <span>日期</span>
          <span>供应商 / 模型</span>
          <span>场景</span>
          <span class="num">轮 / 请求</span>
          <span class="num">输入</span>
          <span class="num">缓存读</span>
          <span class="num">缓存写</span>
          <span class="num">命中率</span>
          <span class="num">输出</span>
          <span class="num">思考</span>
        </div>
        <div
          v-for="row in visibleRows"
          :key="`${row.date}-${row.providerKey}-${row.modelId}-${row.scene}-${row.projectKey}`"
          class="usage-row"
          :style="{ borderColor: token.colorBorderSecondary }"
        >
          <span>{{ row.date }}</span>
          <span class="usage-model">
            {{ row.providerSlug || row.providerKey }} / {{ row.modelId }}
            <span v-if="row.projectKey !== 'none'" :style="{ color: token.colorTextQuaternary }">
              · {{ row.projectId ?? row.projectKey }}
            </span>
          </span>
          <span>{{ SCENES.find((s) => s.value === row.scene)?.label ?? row.scene }}</span>
          <span class="num">{{ row.runCount }} / {{ row.stepCount }}</span>
          <span class="num">{{ formatMetric(row.inputTokens, row.reportedInputCalls) }}</span>
          <span class="num">
            {{ formatMetric(row.cacheReadTokens, row.reportedCacheReadCalls) }}
          </span>
          <span class="num">
            {{ formatMetric(row.cacheWriteTokens, row.reportedCacheWriteCalls) }}
          </span>
          <span class="num">{{ hitRatioText(row) }}</span>
          <span class="num">{{ formatMetric(row.outputTokens, row.reportedOutputCalls) }}</span>
          <span class="num">
            {{ formatMetric(row.reasoningTokens, row.reportedReasoningCalls) }}
          </span>
        </div>
      </div>
    </a-spin>
  </div>
</template>

<style scoped>
.usage-page {
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  height: 100%;
  overflow-y: auto;
}

.usage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.usage-title {
  font-size: 17px;
  margin: 0;
}

.usage-actions {
  display: flex;
  gap: 8px;
}

.usage-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.usage-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
}

.usage-stat {
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 10px 12px;
}

.usage-stat-label {
  font-size: 12px;
}

.usage-stat-value {
  font-size: 18px;
  font-variant-numeric: tabular-nums;
}

.usage-table {
  border: 1px solid transparent;
  border-radius: 10px;
  overflow: hidden;
  font-size: 12px;
}

.usage-row {
  display: grid;
  grid-template-columns: 84px minmax(140px, 1.6fr) 72px 70px 1fr 1fr 1fr 62px 1fr 1fr;
  gap: 8px;
  padding: 7px 12px;
  border-top: 1px solid transparent;
  align-items: baseline;
}

.usage-row--head {
  border-top: none;
  font-size: 11px;
}

.usage-model {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
