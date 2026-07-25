<script setup lang="ts">
import { theme } from 'antdv-next'
import {
  CheckOutlined,
  CloseOutlined,
  DownOutlined,
  LoadingOutlined,
  RightOutlined
} from '@antdv-next/icons'
import type { ToolActivity } from '@renderer/stores/chat'

/**
 * 工具调用活动条。
 *
 * 存在的理由很简单:工具协议下模型在调工具的那几十秒里根本不产文字,
 * 没有这个东西聊天框就是一片死寂,用户以为卡住了。
 *
 * 展示策略:进行中全部展开(用户此刻正盯着它);全部结束后自动折叠成
 * 一行摘要——回头看的时候没人关心调了哪十七次工具,只关心做完了没有。
 */

const props = defineProps<{
  activities: ToolActivity[]
  /** 这轮还在跑 */
  streaming?: boolean
}>()

const { token } = theme.useToken()

const manuallyToggled = ref<boolean | null>(null)

const expanded = computed(() =>
  manuallyToggled.value === null ? props.streaming === true : manuallyToggled.value
)

const failed = computed(() => props.activities.filter((a) => a.state === 'error').length)

/**
 * 折叠头的文案。
 *
 * 展开时**不能**再重复"正在执行的那一项"——下面的行里已经有它了,
 * 同一句话带着转圈出现两次,看起来像是并发跑了两个工具。
 * 折叠时才把当前动作提到头上,那时它是唯一的信息来源。
 */
const summary = computed(() => {
  const total = props.activities.length
  const tail = failed.value ? `${total} 步,${failed.value} 步失败` : `已执行 ${total} 步`

  if (expanded.value) return props.streaming ? `执行中 · ${total} 步` : tail
  if (props.streaming) {
    const running = props.activities.find((a) => a.state === 'running')
    return running ? running.label : `执行中 · ${total} 步`
  }
  return tail
})
</script>

<template>
  <div v-if="activities.length" class="activity">
    <button
      type="button"
      class="activity-head"
      :style="{ color: token.colorTextSecondary }"
      @click="manuallyToggled = !expanded"
    >
      <DownOutlined v-if="expanded" class="activity-caret" />
      <RightOutlined v-else class="activity-caret" />
      <LoadingOutlined v-if="streaming" spin />
      <span class="activity-summary">{{ summary }}</span>
    </button>

    <div v-if="expanded" class="activity-body">
      <div v-for="item in activities" :key="item.callId" class="activity-row">
        <span class="activity-icon">
          <LoadingOutlined v-if="item.state === 'running'" spin />
          <CheckOutlined v-else-if="item.state === 'ok'" :style="{ color: token.colorSuccess }" />
          <CloseOutlined v-else :style="{ color: token.colorError }" />
        </span>
        <span class="activity-label">{{ item.label }}</span>
        <span
          v-if="item.summary"
          class="activity-detail"
          :style="{ color: item.state === 'error' ? token.colorError : token.colorTextTertiary }"
        >
          {{ item.summary }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.activity {
  margin: 6px 0;
  font-size: 12px;
}

.activity-head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: none;
  padding: 2px 0;
  cursor: pointer;
  font: inherit;
  color: inherit;
}

.activity-caret {
  font-size: 9px;
  opacity: 0.6;
}

.activity-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 260px;
}

.activity-body {
  margin-top: 4px;
  padding-left: 4px;
  border-left: 1px solid var(--app-border);
}

.activity-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 0 2px 8px;
  line-height: 1.7;
}

.activity-icon {
  flex-shrink: 0;
  font-size: 10px;
  width: 12px;
}

/*
 * flex:1 + min-width:0 缺一不可。
 *
 * 之前这里只写了 word-break: break-all,结果整行塌成了每行一个字:break-all
 * 把这个 flex 项的最小内容宽度变成**一个字符**,而旁边的 detail 又是
 * flex-shrink:0——于是 label 被合法地压到几像素宽。
 *
 * 改用 overflow-wrap: anywhere:只有当单个词真的超过整行时才断,正常路径
 * 按剩余空间自然折行。
 */
.activity-label {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.activity-detail {
  flex-shrink: 0;
  font-size: 11px;
  /* 摘要都是「没问题」「12 行」这种短句,不该被折断 */
  white-space: nowrap;
}
</style>
