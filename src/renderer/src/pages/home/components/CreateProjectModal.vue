<script setup lang="ts">
import { App, theme } from 'antdv-next'
import { useProjectStore } from '@renderer/stores/project'
import type { DesignMode, Stack } from '@shared/types'

// 走 App.useApp() 而不是静态导入:静态那份取不到 ConfigProvider 的
// 上下文,主题、语言、z-index 全用的是默认值
const { message } = App.useApp()

const open = defineModel<boolean>('open', { default: false })

const emit = defineEmits<{ created: [projectId: string] }>()

const { token } = theme.useToken()
const store = useProjectStore()

const form = reactive({
  name: '',
  stack: 'html' as Stack,
  designMode: 'design' as DesignMode,
  description: ''
})

const STACK_OPTIONS: { value: Stack; label: string; color: string; hint: string }[] = [
  {
    value: 'html',
    label: 'HTML',
    color: '#e8662c',
    hint: '自包含页面,预览最稳,适合视觉稿与营销页'
  },
  { value: 'vue3', label: 'Vue 3', color: '#31a06e', hint: 'SFC 组件形态,适合落进 Vue 工程' },
  { value: 'react', label: 'React', color: '#2f7fd6', hint: 'JSX 组件形态,适合落进 React 工程' }
]

const MODE_OPTIONS = [
  { label: '高质量 UI 设计', value: 'design' },
  { label: '快速原型', value: 'prototype' }
]

const creating = ref(false)

async function submit(): Promise<void> {
  if (!form.name.trim()) {
    message.warning('请输入项目名称')
    return
  }
  creating.value = true
  try {
    const project = await store.create({
      name: form.name.trim(),
      stack: form.stack,
      designMode: form.designMode,
      description: form.description.trim()
    })
    open.value = false
    form.name = form.description = ''
    emit('created', project.id)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <a-modal
    v-model:open="open"
    title="新建项目"
    :confirm-loading="creating"
    :width="520"
    ok-text="创建项目"
    @ok="submit"
  >
    <a-form layout="vertical" style="margin-top: 8px">
      <a-form-item label="项目名称" required>
        <a-input
          v-model:value="form.name"
          size="large"
          placeholder="如 官网改版 / 管理后台"
          @press-enter="submit"
        />
      </a-form-item>

      <a-form-item label="产物技术栈(创建后不可更改)">
        <div class="stack-grid">
          <div
            v-for="opt in STACK_OPTIONS"
            :key="opt.value"
            class="stack-item"
            :class="{ 'stack-item--active': form.stack === opt.value }"
            :style="
              form.stack === opt.value
                ? { borderColor: opt.color, boxShadow: `0 0 0 1px ${opt.color}` }
                : { borderColor: token.colorBorderSecondary }
            "
            @click="form.stack = opt.value"
          >
            <span class="stack-item-label" :style="{ color: opt.color }">
              <i class="stack-item-dot" :style="{ background: opt.color }" />
              {{ opt.label }}
            </span>
            <span class="stack-item-hint" :style="{ color: token.colorTextTertiary }">
              {{ opt.hint }}
            </span>
          </div>
        </div>
      </a-form-item>

      <a-form-item label="设计模式">
        <a-segmented v-model:value="form.designMode" :options="MODE_OPTIONS" block />
      </a-form-item>

      <a-form-item label="项目描述">
        <a-textarea
          v-model:value="form.description"
          :rows="3"
          placeholder="一句话说明这个项目要做什么,会作为 AI 的背景信息"
        />
      </a-form-item>
    </a-form>
  </a-modal>
</template>

<style scoped>
.stack-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.stack-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 12px;
  cursor: pointer;
  transition: all 0.15s;
}

.stack-item-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  font-size: 13px;
}

.stack-item-dot {
  width: 8px;
  height: 8px;
  border-radius: 3px;
}

.stack-item-hint {
  font-size: 12px;
  line-height: 1.5;
}
</style>
