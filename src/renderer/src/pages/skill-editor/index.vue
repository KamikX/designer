<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { App, theme } from 'antdv-next'
import { ArrowLeftOutlined } from '@antdv-next/icons'
import type { SkillFileNode } from '@shared/types'
import SkillFileTree from './components/SkillFileTree.vue'
import SkillCodeEditor from './components/SkillCodeEditor.vue'

/**
 * 「我的技能」编辑器:左树右编辑器,直接读写 ~/.antd-designer/skills 下的
 * 文件。技能的身份就是目录名(路由参数),没有中间层的保存/发布概念——
 * 写进文件就生效。
 *
 * 保存策略是"尽量别让用户想起保存这回事":Cmd+S 立即存,停手 2s 自动存,
 * 切文件、离开页面也存。脏标记只在工具栏提示一下,不弹任何"要不要保存"。
 */

const { token } = theme.useToken()
const { message } = App.useApp()
const route = useRoute()
const router = useRouter()

const skillName = computed(() => String(route.params.name ?? ''))

const nodes = ref<SkillFileNode[]>([])
const currentPath = ref('')
const currentContent = ref('')
const dirty = ref(false)
const treeWidth = ref(200)

const isMac = navigator.userAgent.includes('Mac')
const saveHint = isMac ? '⌘S' : 'Ctrl+S'

function errText(err: unknown): string {
  return uiMessage(err instanceof Error ? err.message : String(err))
}

async function loadTree(): Promise<void> {
  try {
    nodes.value = await window.api.skill.tree(skillName.value)
  } catch (err) {
    message.error(errText(err))
  }
}

/**
 * 保存当前文件。快照后落盘:await 期间用户可能还在敲字,只有内容没被
 * 追着改过才敢清脏标记,否则那几个字就"看着已保存,实际没落盘"。
 */
async function save(): Promise<void> {
  if (!dirty.value || !currentPath.value) return
  const path = currentPath.value
  const text = currentContent.value
  try {
    await window.api.skill.writeFile(skillName.value, path, text)
    if (currentPath.value === path && currentContent.value === text) dirty.value = false
  } catch (err) {
    message.error(errText(err))
  }
}

const autoSave = useDebounceFn(save, 2000)

function markDirty(): void {
  dirty.value = true
  autoSave()
}

/** 切文件:先把手上这份存了再走,编辑内容不设"未保存就丢"的坑 */
async function openFile(path: string): Promise<void> {
  if (path === currentPath.value) return
  await save()
  try {
    const text = await window.api.skill.readFile(skillName.value, path)
    // 先灌内容再切 path:编辑器以 path 变化为换 model 的信号,换的那一刻
    // content 必须已经是新文件的
    currentContent.value = text
    currentPath.value = path
    dirty.value = false
  } catch (err) {
    message.error(errText(err))
  }
}

async function onCreateFile(path: string): Promise<void> {
  try {
    await window.api.skill.writeFile(skillName.value, path, '')
    await loadTree()
    await openFile(path)
  } catch (err) {
    message.error(errText(err))
  }
}

async function onCreateDir(path: string): Promise<void> {
  try {
    await window.api.skill.mkdir(skillName.value, path)
    await loadTree()
  } catch (err) {
    message.error(errText(err))
  }
}

async function onRemove(path: string): Promise<void> {
  // 删的是正在编辑的文件(或它所在的目录):先把编辑器清空,不然
  // 防抖保存醒来会把内容写回一个刚删掉的路径,等于"删不掉"
  if (currentPath.value === path || currentPath.value.startsWith(`${path}/`)) {
    currentPath.value = ''
    currentContent.value = ''
    dirty.value = false
  }
  try {
    await window.api.skill.removeEntry(skillName.value, path)
    await loadTree()
  } catch (err) {
    message.error(errText(err))
  }
}

onMounted(async () => {
  await loadTree()
  // SKILL.md 是技能的入口与身份说明,默认打开它;没有就等用户自己选
  if (nodes.value.some((n) => n.type === 'file' && n.path === 'SKILL.md')) {
    await openFile('SKILL.md')
  }
})

/**
 * Cmd/Ctrl+S。挂 window 捕获阶段:Monaco 没绑这个键,但事件要抢在
 * 浏览器默认的"保存网页"对话框之前拦下来。
 */
function onKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    save()
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true)
  // 离开页面前兜底存一次。IPC 在组件卸载后照样会完成,不用等
  save()
})
</script>

<template>
  <div class="skill-editor">
    <div class="skill-editor-bar" :style="{ borderColor: token.colorBorderSecondary }">
      <a-button size="small" type="text" @click="router.back()">
        <template #icon><ArrowLeftOutlined /></template>
        {{ t('返回') }}
      </a-button>
      <span class="skill-editor-name">{{ skillName }}</span>
      <span
        class="skill-editor-status"
        :style="{ color: dirty ? token.colorWarning : token.colorTextTertiary }"
      >
        {{ dirty ? t('未保存 · {0} 保存', saveHint) : t('已保存') }}
      </span>
    </div>

    <a-splitter class="skill-editor-body" @resize="(sizes: number[]) => (treeWidth = sizes[0])">
      <!-- 样式挂在 <a-splitter-panel> 上不生效,要多包一层,
           原因见 pages/project/index.vue 里的说明 -->
      <a-splitter-panel :default-size="treeWidth" :min="140" :max="360">
        <SkillFileTree
          :nodes="nodes"
          :selected-path="currentPath"
          @select="openFile"
          @create-file="onCreateFile"
          @create-dir="onCreateDir"
          @remove="onRemove"
          @refresh="loadTree"
        />
      </a-splitter-panel>
      <a-splitter-panel :min="320">
        <div class="skill-editor-code">
          <SkillCodeEditor
            v-model:content="currentContent"
            :skill-name="skillName"
            :path="currentPath"
            @dirty="markDirty"
          />
        </div>
      </a-splitter-panel>
    </a-splitter>
  </div>
</template>

<style scoped>
.skill-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0 var(--page-pad) var(--page-pad);
}

.skill-editor-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0 8px;
  border-bottom: 1px solid transparent;
  margin-bottom: 8px;
}

.skill-editor-name {
  font-size: 14px;
  font-weight: 600;
}

.skill-editor-status {
  font-size: 12px;
  margin-left: auto;
}

.skill-editor-body {
  flex: 1;
  min-height: 0;
}

.skill-editor-code {
  height: 100%;
  padding-left: 8px;
}
</style>
