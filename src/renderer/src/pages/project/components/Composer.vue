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
  PauseOutlined
} from '@antdv-next/icons'
import { useRouter } from 'vue-router'
import { App } from 'antdv-next'
import { useChatStore } from '@renderer/stores/chat'
import { useProviderStore } from '@renderer/stores/provider'
import ModelSelect from './ModelSelect.vue'
import WorkspaceRoots from './WorkspaceRoots.vue'
import type { ChatAttachment } from '@renderer/stores/chat'
import { reconcileNames } from '@renderer/stores/selection'
import { MAX_FILES_AT_ONCE } from '@shared/limits'
import { useAnnotationStore } from '@renderer/stores/annotation'
import type { MarkTarget } from '@renderer/stores/annotation'
import { composeMarks, composeMessageBody, planAttachment } from '../attach'
import type { GrantedRoot, InstalledSkill, McpServerView, RootScope } from '@shared/types'

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
const annotation = useAnnotationStore()

const draft = ref('')

/**
 * 预览标注的 chips。和参考图、本地文件同一排位置、同一套语义:
 * 挂在这里,随下一条消息发出去,发完清空(见 stores/annotation.ts)。
 *
 * 本组件被纯聊天页复用,而 annotation 是全局 store:从工作台标了几处又跑去
 * 聊天页时,那些标记不该跟过去——聊天没有预览,发过去也是无源之水。
 */
const marks = computed(() => (chatStore.projectId ? annotation.marks : []))

function markLabel(target: MarkTarget): string {
  const text = target.text ? `「${target.text.slice(0, 10)}」` : ''
  const cls = !text && target.classes.length ? `.${target.classes[0]}` : ''
  return `${target.tag}${text}${cls}`
}

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
  // 只标了几处、一个字没打也该能发:标注本身就是需求("这几处改掉")
  const hasContent =
    text || attachments.value.length > 0 || localFiles.value.length > 0 || marks.value.length > 0
  if (!hasContent || chatStore.streaming || props.disabled) return

  const files = attachments.value
  const body = composeMarks(
    composeMessageBody(
      text,
      localFiles.value.map((f) => f.path)
    ),
    marks.value
  )

  draft.value = ''
  attachments.value = []
  localFiles.value = []
  // 只清这一轮真的带上的:在纯聊天里发消息不该把工作台里标好的东西抹掉
  if (marks.value.length) annotation.clear()
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

/**
 * 技能与 MCP 都是**手动勾选制,默认零加载**。
 *
 * 技能按来源分组:
 * - 我的(app,~/.antd-designer/skills):勾了才可用;
 * - 全局(agents/claude,跨工具共享目录):同上;
 * - 内置(builtin 与 builtin-* 领域包):同样勾了才可用。唯一例外是
 *   **设计会话里的 builtin 设计技能**——自动生效,只展示不勾选,
 *   关不掉才更该让用户看见,否则模型行为里有一大块来源不明。
 *
 * MCP 来自 ~/.antd-designer/mcp.json,勾了才连接,没有内置一说。
 */
const mcpServers = ref<McpServerView[]>([])
const mcpProblem = ref('')
const fileSkills = ref<InstalledSkill[]>([])

/**
 * 弹层内搜索。全局技能目录动辄几十个,不搜没法找。
 * 按名字 + 描述匹配——用户经常记得"是干什么的"但想不起叫什么。
 */
const skillFilter = ref('')
const mcpFilter = ref('')

function matches(filter: string, ...texts: (string | undefined)[]): boolean {
  const q = filter.trim().toLowerCase()
  if (!q) return true
  return texts.some((t) => t?.toLowerCase().includes(q))
}

const filteredMcpServers = computed(() =>
  mcpServers.value
    .filter((s) => matches(mcpFilter.value, s.name))
    // 能操作的在前:已停用的勾不了,沉到底部,和技能弹层同一套排序原则
    .sort((a, b) => Number(b.enabled) - Number(a.enabled))
)

const isDesign = computed(() => !!chatStore.projectId)
/** 自动生效、锁死展示的技能:仅设计会话里的 builtin 设计技能 */
const builtinSkills = computed(() =>
  isDesign.value
    ? fileSkills.value.filter(
        (s) => s.source === 'builtin' && matches(skillFilter.value, s.name, s.description)
      )
    : []
)
const mySkills = computed(() =>
  fileSkills.value.filter(
    (s) => s.source === 'app' && matches(skillFilter.value, s.name, s.description)
  )
)
const globalSkills = computed(() =>
  fileSkills.value.filter(
    (s) =>
      (s.source === 'agents' || s.source === 'claude') &&
      matches(skillFilter.value, s.name, s.description)
  )
)
/**
 * 可勾选的内置技能:builtin-* 领域包一直可勾;builtin 设计技能只在纯聊天
 * 可勾(设计会话里它已经自动生效,再给复选框就成了"看起来能关其实关不掉")。
 */
const builtinSelectable = computed(() =>
  fileSkills.value.filter(
    (s) =>
      s.source.startsWith('builtin') &&
      !(isDesign.value && s.source === 'builtin') &&
      matches(skillFilter.value, s.name, s.description)
  )
)

async function loadToolbox(): Promise<void> {
  const [m, s] = await Promise.all([window.api.mcp.list(), window.api.market.installedSkills()])
  mcpServers.value = m.servers
  mcpProblem.value = m.problem ?? ''
  fileSkills.value = s
  // 只在内存里对齐(剔掉已不存在的名字),不写回存档:用户可能只是暂时
  // 把某个技能移走了,再装回来时这个会话还该记得它
  chatStore.mcpIds = reconcileNames(chatStore.mcpIds, m.servers)
  // 设计会话里 builtin 设计技能是自动生效的,不该出现在勾选存档里;纯聊天全放行
  chatStore.skillIds = reconcileNames(
    chatStore.skillIds,
    isDesign.value ? s.filter((x) => x.source !== 'builtin') : s
  )
}

// 换项目时 store 里的选择被重置成新项目的存档,工具箱要跟着重新对齐
watch(() => chatStore.projectId, loadToolbox, { immediate: true })

const mcpCount = computed(() => chatStore.mcpIds?.length ?? 0)
const skillCount = computed(() => (chatStore.skillIds?.length ?? 0) + builtinSkills.value.length)

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

    <!-- 预览里标记的元素。带源码坐标的标一个点,让用户知道这一处是精确的 -->
    <div v-if="marks.length" class="composer-marks">
      <div
        v-for="mark in marks"
        :key="mark.id"
        class="composer-mark"
        :title="mark.note || mark.target.path"
        :style="{ borderColor: token.colorBorderSecondary, color: token.colorTextSecondary }"
      >
        <span class="composer-mark-no" :style="{ background: token.colorPrimary }">
          {{ mark.index }}
        </span>
        <span class="composer-mark-el">{{ markLabel(mark.target) }}</span>
        <span v-if="mark.note" class="composer-mark-note">{{ mark.note }}</span>
        <span
          v-if="mark.target.source"
          class="composer-mark-src"
          :style="{ color: token.colorSuccess }"
          title="已定位到源码行"
        >
          ●
        </span>
        <button type="button" class="composer-file-remove" @click="annotation.remove(mark.id)">
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
            @click="chatStore.setWebSearch(!chatStore.webSearch)"
          >
            <GlobalOutlined />
          </button>
        </a-tooltip>

        <!-- MCP 服务选择 -->
        <a-popover trigger="click" placement="topLeft">
          <template #content>
            <div class="toolbox-pop">
              <div class="toolbox-pop-title">本会话使用的 MCP 服务(勾选才连接)</div>
              <div
                v-if="mcpProblem"
                class="toolbox-pop-warn"
                :style="{ color: token.colorWarning }"
              >
                {{ mcpProblem }}
              </div>
              <a-input
                v-if="mcpServers.length > 5"
                v-model:value="mcpFilter"
                size="small"
                allow-clear
                placeholder="搜索服务名"
                class="toolbox-pop-search"
              />
              <a-empty
                v-if="mcpServers.length === 0"
                description="还没有配置 MCP 服务"
                :image-style="{ height: '48px' }"
              />
              <a-empty
                v-else-if="filteredMcpServers.length === 0"
                description="没有匹配的服务"
                :image-style="{ height: '48px' }"
              />
              <label v-for="s in filteredMcpServers" :key="s.name" class="toolbox-pop-row">
                <a-checkbox
                  :checked="chatStore.mcpIds?.includes(s.name)"
                  :disabled="!s.enabled"
                  @change="chatStore.setMcpIds(toggleId(chatStore.mcpIds, s.name))"
                />
                <span class="toolbox-pop-name">{{ s.name }}</span>
                <span class="toolbox-pop-meta">
                  {{ s.transport
                  }}{{ s.missingEnv?.length ? ` · 缺 ${s.missingEnv.join(', ')}` : ''
                  }}{{ s.enabled ? '' : ' · 已停用' }}
                </span>
              </label>
              <a class="toolbox-pop-manage" @click="router.push('/market')">
                <SettingOutlined /> 管理 MCP 服务
              </a>
            </div>
          </template>
          <!-- 工具条只放图标,名字进 tooltip:tooltip 套在 popover 的触发器上,
               悬停出名字、点击出面板,两者不打架 -->
          <a-tooltip title="MCP 服务">
            <button class="toolbox-btn" :style="{ color: token.colorTextSecondary }" type="button">
              <ApiOutlined />
              <span v-if="mcpCount" class="toolbox-badge tabular">{{ mcpCount }}</span>
            </button>
          </a-tooltip>
        </a-popover>

        <!-- 技能选择 -->
        <a-popover trigger="click" placement="topLeft">
          <template #content>
            <div class="toolbox-pop">
              <div class="toolbox-pop-title">本会话使用的技能(勾选才可用)</div>

              <a-input
                v-if="fileSkills.length > 5"
                v-model:value="skillFilter"
                size="small"
                allow-clear
                placeholder="搜索技能名或描述"
                class="toolbox-pop-search"
              />

              <!-- 能操作的分组在前:用户打开弹层是来勾选的,别让一屏只读项
                   把可勾的挤到折叠线以下 -->
              <template v-if="mySkills.length">
                <div class="toolbox-pop-group" :style="{ color: token.colorTextTertiary }">
                  我的技能
                </div>
                <label v-for="s in mySkills" :key="s.name" class="toolbox-pop-row">
                  <a-checkbox
                    :checked="chatStore.skillIds?.includes(s.name)"
                    @change="chatStore.setSkillIds(toggleId(chatStore.skillIds, s.name))"
                  />
                  <span class="toolbox-pop-name">{{ s.name }}</span>
                  <span class="toolbox-pop-meta">{{ s.description }}</span>
                </label>
              </template>

              <template v-if="globalSkills.length">
                <div class="toolbox-pop-group" :style="{ color: token.colorTextTertiary }">
                  全局技能
                </div>
                <label v-for="s in globalSkills" :key="s.name" class="toolbox-pop-row">
                  <a-checkbox
                    :checked="chatStore.skillIds?.includes(s.name)"
                    @change="chatStore.setSkillIds(toggleId(chatStore.skillIds, s.name))"
                  />
                  <span class="toolbox-pop-name">{{ s.name }}</span>
                  <span class="toolbox-pop-meta">{{ s.description }}</span>
                </label>
              </template>

              <template v-if="builtinSelectable.length">
                <div class="toolbox-pop-group" :style="{ color: token.colorTextTertiary }">
                  内置技能
                </div>
                <label v-for="s in builtinSelectable" :key="s.name" class="toolbox-pop-row">
                  <a-checkbox
                    :checked="chatStore.skillIds?.includes(s.name)"
                    @change="chatStore.setSkillIds(toggleId(chatStore.skillIds, s.name))"
                  />
                  <span class="toolbox-pop-name">{{ s.name }}</span>
                  <span class="toolbox-pop-meta">{{ s.description }}</span>
                </label>
              </template>

              <!-- 自动生效的内置技能放最后:关不掉也取消不了,但必须让用户看见
                   ——否则模型行为里有一大块来源不明,他会以为是模型自己的脾气 -->
              <template v-if="builtinSkills.length">
                <div class="toolbox-pop-group" :style="{ color: token.colorTextTertiary }">
                  内置(设计会话自动生效)
                </div>
                <label
                  v-for="s in builtinSkills"
                  :key="s.name"
                  class="toolbox-pop-row toolbox-pop-row--fixed"
                >
                  <a-checkbox :checked="true" disabled />
                  <span class="toolbox-pop-name">{{ s.name }}</span>
                  <span class="toolbox-pop-meta">{{ s.description }}</span>
                </label>
              </template>

              <a-empty
                v-if="
                  !builtinSkills.length &&
                  !builtinSelectable.length &&
                  !mySkills.length &&
                  !globalSkills.length
                "
                :description="fileSkills.length ? '没有匹配的技能' : '还没有任何技能'"
                :image-style="{ height: '48px' }"
              />
              <a class="toolbox-pop-manage" @click="router.push('/market')">
                <SettingOutlined /> 管理技能
              </a>
            </div>
          </template>
          <a-tooltip title="技能">
            <button class="toolbox-btn" :style="{ color: token.colorTextSecondary }" type="button">
              <BulbOutlined />
              <span v-if="skillCount" class="toolbox-badge tabular">{{ skillCount }}</span>
            </button>
          </a-tooltip>
        </a-popover>
      </div>

      <!-- 发送 / 停止 -->
      <a-tooltip :title="chatStore.streaming ? '停止生成' : 'Enter 发送,Shift+Enter 换行'">
        <!-- 流式中是"暂停"而不是红色警告:停止生成是常规操作,已产出的内容
             会照常保留成版本,不该用危险色吓用户 -->
        <a-button
          v-if="chatStore.streaming"
          class="composer-send"
          type="primary"
          shape="circle"
          @click="chatStore.abort()"
        >
          <template #icon><PauseOutlined /></template>
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

/* 标注 chips:和文件 chips 一个形状,只是多一个和 iframe 里徽标对得上的编号 */
.composer-marks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 4px 2px;
}

.composer-mark {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 3px 6px 3px 4px;
  font-size: 12px;
}

.composer-mark-no {
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  padding: 0 4px;
}

.composer-mark-el {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-mark-note {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.7;
}

.composer-mark-src {
  font-size: 8px;
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

/*
 * 计数徽标走中性填充,不上主色。
 *
 * 这一屏的规矩:**开着的模式**才配主色(旁边的联网开关就是),
 * "勾了几个"只是一个数。一排工具按钮各挂一颗蓝点的话,输入框里最亮的
 * 像素说的是"你勾了 3 个技能"——而它是这排东西里最不重要的一句。
 */
.toolbox-badge {
  min-width: 16px;
  height: 16px;
  border-radius: var(--radius-pill);
  /* 实心的中性灰配面板色的字:没有主色也一眼是个"计数芯片",
     用半透明填充的话圆形边界看不出来,数字像是浮在图标旁边 */
  background: var(--text-soft);
  color: var(--bg-panel);
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  padding: 0 4px;
}

/*
 * 高度必须封顶。技能按分组列出来之后(内置 + 我的 + 全局)条目轻松过二十条,
 * 不封顶的话 popover 会长过视口,把整个页面顶出滚动条——弹层内部自己滚,
 * 页面不动。360px 约容得下 9-10 行,再多就滚。
 */
.toolbox-pop {
  width: 260px;
  max-height: 360px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.toolbox-pop-group {
  font-size: 11px;
  padding: 6px 4px 2px;
}

/* mcp.json 解析出问题时的提示行 */
.toolbox-pop-warn {
  font-size: 12px;
  padding: 2px 4px 6px;
}

.toolbox-pop-search {
  margin-bottom: 8px;
}

/* 内置项不可勾选,压暗一点表明"看得见但动不了" */
.toolbox-pop-row--fixed {
  cursor: default;
  opacity: 0.75;
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
