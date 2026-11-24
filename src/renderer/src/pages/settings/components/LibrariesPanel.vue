<script setup lang="ts">
import { App } from 'antdv-next'
import { t, uiMessage } from '@renderer/i18n'
import type { InstalledLibrary, InstallLibraryInput, LibraryProgress } from '@shared/types'

const { message } = App.useApp()
const libraries = ref<InstalledLibrary[]>([])
const open = ref(false)
const busy = ref(false)
const editing = ref<InstalledLibrary | null>(null)
const progress = ref<LibraryProgress | null>(null)
const error = ref('')
const subpaths = ref('')
const css = ref('')
const blank = (): InstallLibraryInput => ({
  name: '',
  version: '',
  stacks: ['vue3', 'react'],
  description: '',
  instructions: '',
  subpaths: [],
  css: []
})
const form = reactive(blank())
const stackOptions = [
  { label: 'Vue 3', value: 'vue3' },
  { label: 'React', value: 'react' }
]
let unsubscribe: (() => void) | undefined
async function load(): Promise<void> {
  try {
    libraries.value = await window.api.libraries.list()
  } catch (e) {
    error.value = uiMessage(String(e))
  }
}
onMounted(() => {
  void load()
  unsubscribe = window.api.libraries.onProgress((event) => {
    if (event.name === form.name && event.version === form.version) progress.value = event
  })
})
onUnmounted(() => unsubscribe?.())
function edit(lib: InstalledLibrary | null): void {
  editing.value = lib
  Object.assign(form, lib ? { ...lib, stacks: [...lib.stacks] } : blank())
  subpaths.value = lib?.subpaths.join('\n') ?? ''
  css.value = lib?.css.join('\n') ?? ''
  error.value = ''
  progress.value = null
  open.value = true
}
const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean)
async function save(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    if (editing.value)
      await window.api.libraries.update(
        { name: editing.value.name, version: editing.value.version },
        {
          description: form.description,
          instructions: form.instructions
        }
      )
    else
      await window.api.libraries.install({
        name: form.name.trim(),
        version: form.version.trim(),
        stacks: [...form.stacks],
        description: form.description,
        instructions: form.instructions,
        subpaths: lines(subpaths.value),
        css: lines(css.value)
      })
    await load()
    open.value = false
    message.success(t('依赖库已保存'))
  } catch (e) {
    error.value = uiMessage(String(e))
  } finally {
    busy.value = false
  }
}
async function remove(lib: InstalledLibrary): Promise<void> {
  try {
    await window.api.libraries.remove({ name: lib.name, version: lib.version })
    await load()
  } catch (e) {
    message.error(uiMessage(String(e)))
  }
}
</script>

<template>
  <div class="libraries-panel">
    <p>{{ t('全局安装，按项目选择。安装后可离线使用；每个项目固定使用所选版本。') }}</p>
    <a-button type="primary" @click="edit(null)">{{ t('安装 npm 包') }}</a-button>
    <a-alert v-if="error && !open" type="error" :message="error" />
    <div class="library-card">
      <strong>antdv-next · @antdv-next/icons</strong>
      <a-tag>{{ t('内置') }}</a-tag>
      <p>{{ t('Vue 3 组件库，沿用现有 CDN 加载方式。') }}</p>
    </div>
    <div v-for="lib in libraries" :key="lib.id" class="library-card">
      <a-space wrap
        ><strong>{{ lib.name }}@{{ lib.version }}</strong
        ><a-tag>{{ lib.stacks.join(' / ') }}</a-tag
        ><a-tag :color="lib.ready ? 'green' : 'red'">{{
          lib.ready ? t('已安装') : t('文件缺失，请重新安装')
        }}</a-tag></a-space
      >
      <p>{{ lib.description }}</p>
      <a-space
        ><a-button size="small" @click="edit(lib)">{{ t('编辑说明') }}</a-button>
        <a-popconfirm :title="t('卸载此版本？')" @confirm="remove(lib)"
          ><a-button size="small" danger>{{ t('卸载') }}</a-button></a-popconfirm
        >
      </a-space>
    </div>
    <a-modal
      v-model:open="open"
      :title="editing ? t('编辑说明') : t('安装 npm 包')"
      :confirm-loading="busy"
      :closable="!busy"
      :mask-closable="!busy"
      :keyboard="!busy"
      :cancel-button-props="{ disabled: busy }"
      @ok="save"
    >
      <a-form layout="vertical" class="library-form">
        <a-form-item :label="t('npm 包名')"
          ><a-input v-model:value="form.name" :disabled="!!editing || busy" placeholder="zod"
        /></a-form-item>
        <a-form-item :label="t('精确版本')"
          ><a-input v-model:value="form.version" :disabled="!!editing || busy" placeholder="4.4.3"
        /></a-form-item>
        <a-form-item :label="t('支持的技术栈')"
          ><a-checkbox-group
            v-model:value="form.stacks"
            :disabled="!!editing || busy"
            :options="stackOptions"
        /></a-form-item>
        <a-form-item :label="t('描述')"
          ><a-input v-model:value="form.description" :disabled="busy"
        /></a-form-item>
        <a-form-item :label="t('给 AI 的使用说明和示例')"
          ><a-textarea v-model:value="form.instructions" :rows="5" :disabled="busy"
        /></a-form-item>
        <a-form-item :label="t('额外 import 路径，每行一个（可选）')"
          ><a-textarea
            v-model:value="subpaths"
            :rows="2"
            placeholder="zod/v4"
            :disabled="!!editing || busy"
        /></a-form-item>
        <a-form-item :label="t('包内 CSS 路径，每行一个（可选）')"
          ><a-textarea
            v-model:value="css"
            :rows="2"
            placeholder="dist/style.css"
            :disabled="!!editing || busy"
        /></a-form-item>
        <a-alert v-if="busy && progress" type="info" :message="progress.message" />
        <a-alert v-if="error" type="error" :message="error" />
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.libraries-panel {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 16px;
}
.library-card {
  width: 100%;
  padding: 16px;
  border: 1px solid var(--ant-color-border-secondary, #8884);
  border-radius: 8px;
  overflow-wrap: anywhere;
}
.library-form {
  max-height: 65vh;
  overflow-y: auto;
  padding-right: 8px;
}
</style>
