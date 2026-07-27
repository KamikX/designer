<script setup lang="ts">
import { theme } from 'antdv-next'
import { CheckOutlined, CopyOutlined } from '@antdv-next/icons'

/**
 * 复制到剪贴板的小按钮。
 *
 * 反馈用**按钮自己变成对勾**,不弹全局 message:一次对话里可能连着复制好几条,
 * 每条都弹一个 toast 会盖住内容,而且用户要确认的只是"这一条复制上了没有"。
 *
 * `legacy: true`:打包后渲染层跑在 file:// 上,`navigator.clipboard` 未必可用
 * (安全上下文判定各版本不一),开了才会退回 execCommand。少这一行的表现是
 * 开发时好好的、装出来点了没反应。
 */

const props = defineProps<{
  /** 要复制的原文。调用方负责给"人能读的那份"——比如把结构化提及转成 @名字 */
  text: string
  /** 无障碍标签,默认「复制」 */
  label?: string
}>()

const { token } = theme.useToken()
const { copy, copied } = useClipboard({ legacy: true, copiedDuring: 1500 })
</script>

<template>
  <a-tooltip :title="copied ? '已复制' : (props.label ?? '复制')">
    <button
      class="copy-btn"
      type="button"
      :aria-label="props.label ?? '复制'"
      :disabled="!props.text"
      @click="copy(props.text)"
    >
      <CheckOutlined v-if="copied" :style="{ color: token.colorSuccess }" />
      <CopyOutlined v-else />
    </button>
  </a-tooltip>
</template>

<style scoped>
/*
 * 颜色继承外面:同一个按钮既出现在浅底气泡里,也出现在主色底的用户气泡里,
 * 写死颜色必然有一边看不见。
 */
.copy-btn {
  border: none;
  background: none;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
  color: inherit;
  opacity: 0.5;
  font-size: 12px;
  line-height: 1;
  transition: opacity 0.15s;
}

.copy-btn:hover:not(:disabled) {
  opacity: 1;
  background: rgba(128, 128, 128, 0.15);
}

.copy-btn:disabled {
  cursor: default;
  opacity: 0.25;
}
</style>
