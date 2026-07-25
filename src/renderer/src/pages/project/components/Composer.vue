<script setup lang="ts">
import { theme } from 'antdv-next'
import {
  ApiOutlined,
  ArrowUpOutlined,
  BulbOutlined,
  CloseOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  GlobalOutlined,
  PictureOutlined,
  PlusOutlined,
  SettingOutlined,
  StopOutlined
} from '@antdv-next/icons'
import { useRouter } from 'vue-router'
import { App } from 'antdv-next'
import { useChatStore } from '@renderer/stores/chat'
import { useProviderStore } from '@renderer/stores/provider'
import ModelSelect from './ModelSelect.vue'
import WorkspaceRoots from './WorkspaceRoots.vue'
import type { ChatAttachment } from '@renderer/stores/chat'
import { reconcileIds } from '@renderer/stores/selection'
import { MAX_FILES_AT_ONCE } from '@shared/limits'
import { composeMessageBody, planAttachment } from '../attach'
import type { GrantedRoot, McpServer, RootScope, Skill } from '@shared/types'

/**
 * 一体化输入框:无边框多行输入 + 底部工具条。
 * 工具条左侧:模型选择、MCP 服务选择器、技能选择器;右侧:发送/停止。
 * MCP 与技能的勾选是"本会话生效"的内存态,存在 chat store,
 * 运行时接入后随请求下发。
 */

const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ send: [text: string, attachments: ChatAttachment[]] }>()

const { token } = theme.useToken()
const router = useRouter()
const { message } = App.useApp()
const chatStore = useChatStore()
const providerStore = useProviderStore()

const draft = ref('')

/* ---------------- 参考图 ---------------- */

const attachments = ref<ChatAttachment[]>([])
const dragging = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

/** 当前选中的模型有没有识图能力 */
const canSeeImages = computed(() => {
  const selected = chatStore.selected
  if (!selected) return false
  for (const group of providerStore.chatModels) {
    const hit = group.models.find((m) => m.id === selected.modelId)
    if (hit) return hit.abilities.includes('vision')
  }
  return false
})

/**
 * 拖进来 / 选进来的东西分两条完全不同的路:
 *
 * - **图片**走多模态:字节导入本地存储,发送时把像素喂给模型,所以要求
 *   模型有识图能力。
 * - **其他文件**走本地文件授权:只把路径授权给这个项目,内容由我们自己
 *   解析(pdf/docx/xlsx 有专门的抽取,代码和文本按行读)。模型用
 *   read_local_file / read_local_document 按需取,长文件还能分段读——
 *   所以**不要求多模态,也不受上下文长度限制**。
 *
 * 后者永远不该被塞进消息体里:那等于把整个文件一次性变成 token,
 * 而它可能是个两万行的仓库文件。
 */
async function addFiles(files: File[]): Promise<void> {
  const images = files.filter((f) => f.type.startsWith('image/'))
  const others = files.filter((f) => !f.type.startsWith('image/'))

  if (others.length) await attachLocalFiles(others)
  if (images.length === 0) return

  if (!canSeeImages.value) {
    // 在贴图这一刻就拦住,而不是发出去才报错
    message.warning('当前模型不支持识图,换一个带识图能力的模型才能发图片')
    return
  }

  for (const file of images) {
    try {
      // 变量别叫 ref:自动导入会认为本文件已声明该名字,整份文件的
      // ref / computed 注入全被跳过,然后在别处炸成 "ref is not defined"
      const asset = await window.api.storage.importImage({
        name: file.name || '截图.png',
        mime: file.type,
        data: await file.arrayBuffer()
      })
      // 同一张图去重(主进程按 sha256 判定,这里按 id 兜一层)
      if (attachments.value.some((a) => a.assetId === asset.id)) continue
      attachments.value.push({
        assetId: asset.id,
        name: file.name || '截图.png',
        mime: asset.mime,
        uri: asset.uri,
        width: asset.width,
        height: asset.height
      })
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }
}

/* ---------------- 本地文件附件 ---------------- */

/** 本轮附上的本地文件。它们同时也被授权成了 workspace root,可随时撤销 */
const localFiles = ref<GrantedRoot[]>([])

async function attachLocalFiles(files: File[]): Promise<void> {
  // 聊天起始页还没有会话,而授权需要一个归属。拖进来这一刻把它建出来,
  // 否则文件被静默丢弃——用户完全看不出为什么没反应
  await chatStore.ensureChat()
  const scope = chatStore.rootScope
  if (!scope) return

  // File 拿不到磁盘路径,只有 preload 里的 webUtils 能;拿不到就没法授权
  const paths = files.map((f) => window.api.workspace.pathOf(f)).filter(Boolean)
  if (paths.length === 0) {
    message.warning('没能取到这些文件的本地路径,试试用「+ → 文件」选择')
    return
  }

  const plan = planAttachment(localFiles.value.length, paths.length)
  if (plan.overflow) {
    // 超过上限时给的不是"少传点",而是**换个更好的做法**
    message.warning(
      `一次最多附 ${MAX_FILES_AT_ONCE} 个文件。文件多的话,直接用「目录」授权它们所在的文件夹,` +
        `让 AI 自己检索需要的部分——比一个个附上更省 token,也更容易找全。`
    )
  }
  if (plan.accept === 0) return

  await grantAndCollect(scope, paths.slice(0, plan.accept))
}

async function grantAndCollect(scope: RootScope, paths: string[]): Promise<void> {
  const { granted, rejected } = await window.api.workspace.grantPaths(scope, paths)
  for (const root of granted) {
    if (!localFiles.value.some((f) => f.id === root.id)) localFiles.value.push(root)
  }
  // 让"目录"面板同步显示这些新授权
  chatStore.lastGrantedRoots = granted
  for (const bad of rejected) message.error(`${bad.path}:${bad.reason}`)
}

async function pickLocalFiles(): Promise<void> {
  await chatStore.ensureChat()
  const scope = chatStore.rootScope
  if (!scope) return
  const { granted, rejected } = await window.api.workspace.pickFiles(scope)
  const plan = planAttachment(localFiles.value.length, granted.length)
  if (plan.overflow) message.warning(`一次最多附 ${MAX_FILES_AT_ONCE} 个文件,多出的没有附上。`)
  for (const root of granted.slice(0, plan.accept)) {
    if (!localFiles.value.some((f) => f.id === root.id)) localFiles.value.push(root)
  }
  chatStore.lastGrantedRoots = granted
  for (const bad of rejected) message.error(`${bad.path}:${bad.reason}`)
}

/**
 * 从待发列表里去掉,但**不撤销授权**。
 *
 * 撤销是"目录"面板的事,而且往往不是用户的本意:他只是不想在这条消息里
 * 特意点名这个文件而已。两件事分开。
 */
function dropLocalFile(index: number): void {
  localFiles.value.splice(index, 1)
}

function onDrop(e: DragEvent): void {
  dragging.value = false
  void addFiles([...(e.dataTransfer?.files ?? [])])
}

function onPaste(e: ClipboardEvent): void {
  const files = [...(e.clipboardData?.files ?? [])]
  if (files.some((f) => f.type.startsWith('image/'))) {
    // 有图就别让它同时把文件名当文本粘进来
    e.preventDefault()
    void addFiles(files)
  }
}

function onPick(e: Event): void {
  const input = e.target as HTMLInputElement
  void addFiles([...(input.files ?? [])])
  // 清空,否则连选同一个文件不触发 change
  input.value = ''
}

function send(): void {
  const text = draft.value.trim()
  const hasContent = text || attachments.value.length > 0 || localFiles.value.length > 0
  if (!hasContent || chatStore.streaming || props.disabled) return

  const files = attachments.value
  const body = composeMessageBody(
    text,
    localFiles.value.map((f) => f.path)
  )

  draft.value = ''
  attachments.value = []
  localFiles.value = []
  emit('send', body, files)
}

/**
 * 供外部预填输入框(聊天首页的快捷卡片)。
 *
 * 用 expose 而不是 prop:draft 是输入框的内部状态,做成受控 prop 会让每次
 * 敲键盘都往上冒一次事件,而外部只在"点了卡片"这一个时刻需要写入。
 */
function setDraft(text: string): void {
  draft.value = text
}
defineExpose({ setDraft })

function onEnter(e: KeyboardEvent): void {
  // Enter 发送,Shift+Enter 换行(输入法组合期间不触发)
  if (e.shiftKey || e.isComposing) return
  e.preventDefault()
  send()
}

/* ---------------- MCP / 技能 选择器 ---------------- */

const mcpServers = ref<McpServer[]>([])
const skills = ref<Skill[]>([])

async function loadToolbox(): Promise<void> {
  const [m, s] = await Promise.all([window.api.mcp.list(), window.api.skill.list()])
  mcpServers.value = m
  skills.value = s
  // null = 这个项目还没选过,按全局启用状态给默认值;
  // 已有值(含空数组)是项目存档恢复出来的,只清掉其中已被删除的 id
  // 只在内存里对齐,不写回存档:用户可能只是暂时把某个技能移走了,
  // 再装回来时这个项目还该记得它
  chatStore.mcpIds = reconcileIds(chatStore.mcpIds, m)
  chatStore.skillIds = reconcileIds(chatStore.skillIds, s)
}

// 换项目时 store 里的选择被重置成新项目的存档,工具箱要跟着重新对齐
watch(() => chatStore.projectId, loadToolbox, { immediate: true })

const mcpCount = computed(() => chatStore.mcpIds?.length ?? 0)
const skillCount = computed(() => chatStore.skillIds?.length ?? 0)

function toggleId(list: string[] | null, id: string): string[] {
  const set = new Set(list ?? [])
  if (set.has(id)) set.delete(id)
  else set.add(id)
  return [...set]
}
</script>

<template>
  <div
    class="composer"
    :class="{ 'composer--dragging': dragging }"
    :style="{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <!-- 待发送的参考图 -->
    <div v-if="attachments.length" class="composer-attachments">
      <div v-for="(a, i) in attachments" :key="a.assetId" class="composer-thumb">
        <img :src="a.uri" :alt="a.name" :title="a.name" />
        <button type="button" class="composer-thumb-remove" @click="attachments.splice(i, 1)">
          <CloseOutlined />
        </button>
      </div>
    </div>

    <!-- 本轮附上的本地文件。只带路径,内容由 AI 按需读取 -->
    <div v-if="localFiles.length" class="composer-files">
      <div
        v-for="(f, i) in localFiles"
        :key="f.id"
        class="composer-file"
        :title="f.path"
        :style="{ borderColor: token.colorBorderSecondary, color: token.colorTextSecondary }"
      >
        <FolderOpenOutlined v-if="!f.isFile" />
        <FileTextOutlined v-else />
        <span class="composer-file-name">{{ f.name }}</span>
        <button type="button" class="composer-file-remove" @click="dropLocalFile(i)">
          <CloseOutlined />
        </button>
      </div>
    </div>

    <a-textarea
      v-model:value="draft"
      class="composer-input"
      placeholder="描述你的设计需求,例如:做一个深色风格的数据看板首页…"
      :auto-size="{ minRows: 2, maxRows: 8 }"
      :disabled="disabled"
      variant="borderless"
      @keydown.enter="onEnter"
      @paste="onPaste"
    />

    <div class="composer-toolbar">
      <div class="composer-tools">
        <ModelSelect />

        <span class="composer-divider" :style="{ background: token.colorBorderSecondary }" />

        <!-- 添加:图片走多模态,文件走本地授权。拖拽 / 粘贴 / 从这里选,
             三条路都汇到 addFiles 再分流 -->
        <a-popover trigger="click" placement="topLeft">
          <template #content>
            <div class="add-pop">
              <button
                class="add-pop-row"
                type="button"
                :disabled="!canSeeImages"
                @click="fileInput?.click()"
              >
                <PictureOutlined />
                <span class="add-pop-name">图片</span>
                <span class="add-pop-meta">
                  {{ canSeeImages ? '作为参考图给模型看' : '当前模型不支持识图' }}
                </span>
              </button>
              <button class="add-pop-row" type="button" @click="pickLocalFiles">
                <FileTextOutlined />
                <span class="add-pop-name">文件</span>
                <span class="add-pop-meta">代码 / pdf / docx / xlsx,由 AI 按需读取</span>
              </button>
              <div class="add-pop-hint" :style="{ color: token.colorTextTertiary }">
                也可以直接把文件拖进输入框。文件超过 {{ MAX_FILES_AT_ONCE }} 个时,
                建议改用「目录」授权整个文件夹让 AI 自己检索。
              </div>
            </div>
          </template>
          <a-tooltip title="添加图片或文件">
            <button class="toolbox-btn" :style="{ color: token.colorTextSecondary }" type="button">
              <PlusOutlined />
            </button>
          </a-tooltip>
        </a-popover>
        <input
          ref="fileInput"
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          @change="onPick"
        />

        <!-- 本地目录授权:属于"这次对话给 AI 看什么",和参考图、技能是一类,
             所以放在输入框工具条里,而不是右侧预览区的头部 -->
        <WorkspaceRoots v-if="chatStore.rootScope" :scope="chatStore.rootScope" />

        <!-- 联网开关。点亮才注册 web 工具,默认关 -->
        <a-tooltip :title="chatStore.webSearch ? '联网已开启,点击关闭' : '开启联网搜索'">
          <button
            class="toolbox-btn"
            type="button"
            :style="
              chatStore.webSearch
                ? { color: token.colorPrimary, background: token.colorPrimaryBg }
                : { color: token.colorTextSecondary }
            "
            @click="chatStore.webSearch = !chatStore.webSearch"
          >
            <GlobalOutlined />
            <span>联网</span>
          </button>
        </a-tooltip>

        <!-- MCP 服务选择 -->
        <a-popover trigger="click" placement="topLeft">
          <template #content>
            <div class="toolbox-pop">
              <div class="toolbox-pop-title">本会话使用的 MCP 服务</div>
              <a-empty
                v-if="mcpServers.length === 0"
                description="还没有配置 MCP 服务"
                :image-style="{ height: '48px' }"
              />
              <label v-for="s in mcpServers" :key="s.id" class="toolbox-pop-row">
                <a-checkbox
                  :checked="chatStore.mcpIds?.includes(s.id)"
                  @change="chatStore.setMcpIds(toggleId(chatStore.mcpIds, s.id))"
                />
                <span class="toolbox-pop-name">{{ s.name }}</span>
                <span class="toolbox-pop-meta">{{ s.transport }}</span>
              </label>
              <a class="toolbox-pop-manage" @click="router.push('/settings')">
                <SettingOutlined /> 管理 MCP 服务
              </a>
            </div>
          </template>
          <button class="toolbox-btn" :style="{ color: token.colorTextSecondary }" type="button">
            <ApiOutlined />
            <span>MCP</span>
            <span v-if="mcpCount" class="toolbox-badge" :style="{ background: token.colorPrimary }">
              {{ mcpCount }}
            </span>
          </button>
        </a-popover>

        <!-- 技能选择 -->
        <a-popover trigger="click" placement="topLeft">
          <template #content>
            <div class="toolbox-pop">
              <div class="toolbox-pop-title">本会话使用的技能</div>
              <a-empty
                v-if="skills.length === 0"
                description="还没有配置技能"
                :image-style="{ height: '48px' }"
              />
              <label v-for="s in skills" :key="s.id" class="toolbox-pop-row">
                <a-checkbox
                  :checked="chatStore.skillIds?.includes(s.id)"
                  @change="chatStore.setSkillIds(toggleId(chatStore.skillIds, s.id))"
                />
                <span class="toolbox-pop-name">{{ s.name }}</span>
                <span class="toolbox-pop-meta">{{ s.description }}</span>
              </label>
              <a class="toolbox-pop-manage" @click="router.push('/settings')">
                <SettingOutlined /> 管理技能
              </a>
            </div>
          </template>
          <button class="toolbox-btn" :style="{ color: token.colorTextSecondary }" type="button">
            <BulbOutlined />
            <span>技能</span>
            <span
              v-if="skillCount"
              class="toolbox-badge"
              :style="{ background: token.colorPrimary }"
            >
              {{ skillCount }}
            </span>
          </button>
        </a-popover>
      </div>

      <!-- 发送 / 停止 -->
      <a-tooltip :title="chatStore.streaming ? '停止生成' : 'Enter 发送,Shift+Enter 换行'">
        <a-button
          v-if="chatStore.streaming"
          class="composer-send"
          danger
          type="primary"
          shape="circle"
          @click="chatStore.abort()"
        >
          <template #icon><StopOutlined /></template>
        </a-button>
        <a-button
          v-else
          class="composer-send"
          type="primary"
          shape="circle"
          :disabled="(!draft.trim() && attachments.length === 0) || disabled"
          @click="send"
        >
          <template #icon><ArrowUpOutlined /></template>
        </a-button>
      </a-tooltip>
    </div>
  </div>
</template>

<style scoped>
.composer {
  border: 1px solid transparent;
  border-radius: 14px;
  padding: 4px 8px 8px;
  transition: border-color 0.2s;
}

.composer:focus-within,
.composer--dragging {
  border-color: var(--ant-color-primary);
}

.composer-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 4px 0;
}

.composer-thumb {
  position: relative;
  width: 56px;
  height: 56px;
  border-radius: 8px;
  overflow: hidden;
  background: rgba(128, 128, 128, 0.12);
}

.composer-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.composer-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 9px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 输入框本体去掉边框和聚焦光晕,由外层容器承担 */
.composer-input,
.composer-input:focus {
  border: none !important;
  box-shadow: none !important;
  outline: none;
  resize: none;
  font-size: 13px;
  line-height: 1.7;
  background: transparent !important;
}

.composer-toolbar {
  display: flex;
  /* 左侧换行后发送按钮要留在最后一行,不能飘到垂直居中 */
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 2px 0 4px;
}

/*
 * 工具条上的东西只会越加越多(模型、图片、目录、MCP、技能…),而对话面板
 * 最窄能拖到 300px——横着一行放不下是必然的,不是极端情况。
 *
 * 所以让它换行,而不是靠挤:挤的结果是标签被拆成竖排的单字,发送按钮被
 * 压在最后一个按钮上面。宁可占两行。
 */
.composer-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px 4px;
  min-width: 0;
  flex: 1;
}

.composer-send {
  flex-shrink: 0;
}

/* 本地文件条:只显示文件名,完整路径给 title */
.composer-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 4px 2px;
}

.composer-file {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 3px 6px 3px 8px;
  font-size: 12px;
}

.composer-file-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-file-remove {
  border: none;
  background: none;
  cursor: pointer;
  padding: 0 2px;
  font-size: 10px;
  color: inherit;
  opacity: 0.55;
}

.composer-file-remove:hover {
  opacity: 1;
}

.add-pop {
  width: 260px;
}

.add-pop-row {
  display: grid;
  grid-template-columns: 16px 1fr;
  grid-template-areas: 'icon name' 'icon meta';
  gap: 0 8px;
  width: 100%;
  border: none;
  background: none;
  cursor: pointer;
  text-align: left;
  padding: 6px 8px;
  border-radius: 8px;
  color: inherit;
}

.add-pop-row:hover:not(:disabled) {
  background: rgba(128, 128, 128, 0.12);
}

.add-pop-row:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.add-pop-row > :first-child {
  grid-area: icon;
  align-self: center;
}

.add-pop-name {
  grid-area: name;
  font-size: 13px;
}

.add-pop-meta {
  grid-area: meta;
  font-size: 11px;
  opacity: 0.6;
}

.add-pop-hint {
  font-size: 11px;
  line-height: 1.6;
  padding: 6px 8px 0;
}

.composer-divider {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  flex-shrink: 0;
}

.toolbox-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  /* 不加这个,"目录""技能"会在窄面板里被拆成竖排的单字 */
  white-space: nowrap;
  flex-shrink: 0;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 8px;
  transition: background 0.15s;
}

.toolbox-btn:hover {
  background: rgba(128, 128, 128, 0.12);
}

.toolbox-badge {
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  padding: 0 4px;
}

.toolbox-pop {
  width: 260px;
}

.toolbox-pop-title {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.75;
  margin-bottom: 8px;
}

.toolbox-pop-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  cursor: pointer;
}

.toolbox-pop-name {
  font-size: 13px;
  flex-shrink: 0;
}

.toolbox-pop-meta {
  font-size: 12px;
  opacity: 0.45;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toolbox-pop-manage {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  font-size: 12px;
}
</style>
