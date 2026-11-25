<script setup lang="ts">
import { t } from '@renderer/i18n'
import { App } from 'antdv-next'
import {
  DeleteOutlined,
  FileAddOutlined,
  FileOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  ReloadOutlined
} from '@antdv-next/icons'
import type { SkillFileNode } from '@shared/types'

/**
 * 技能文件树:只管展示与交互,文件操作全部上抛给父组件。
 *
 * 不在这里直接调 window.api——删除/新建会牵动编辑器里正打开的文件
 * (比如删掉正在编辑的那份),这种协调只有持有编辑器状态的父组件做得了。
 */

const props = defineProps<{
  nodes: SkillFileNode[]
  /** 正在编辑的文件路径,'' 表示没打开文件 */
  selectedPath: string
}>()

const emit = defineEmits<{
  select: [path: string]
  createFile: [path: string]
  createDir: [path: string]
  remove: [path: string]
  refresh: []
}>()

const { modal } = App.useApp()

interface TreeNode {
  key: string
  title: string
  isLeaf: boolean
  children?: TreeNode[]
}

const treeData = computed<TreeNode[]>(() => props.nodes.map(toNode))

function toNode(n: SkillFileNode): TreeNode {
  return {
    key: n.path,
    title: n.name,
    isLeaf: n.type === 'file',
    ...(n.type === 'dir' ? { children: (n.children ?? []).map(toNode) } : {})
  }
}

/** path → 类型,判断点的是文件还是目录(a-tree 的回调只给 key) */
const typeOf = computed(() => {
  const map = new Map<string, 'file' | 'dir'>()
  const walk = (list: SkillFileNode[]): void => {
    for (const n of list) {
      map.set(n.path, n.type)
      if (n.children) walk(n.children)
    }
  }
  walk(props.nodes)
  return map
})

/**
 * 展开态。新出现的目录自动并进来(比如刚新建的),手动折叠的代价
 * 与 project 的 FileTree 相同,取舍也相同。
 */
const expandedKeys = ref<string[]>([])

watch(
  () => props.nodes,
  () => {
    const dirs = [...typeOf.value.entries()].filter(([, t]) => t === 'dir').map(([p]) => p)
    expandedKeys.value = [...new Set([...expandedKeys.value, ...dirs])]
  },
  { immediate: true }
)

/**
 * 树自己的选中态,和"正在编辑哪个文件"是两回事:点目录也要有选中反馈,
 * 因为它同时是"接下来在哪儿新建"的目标。
 */
const selectedKeys = ref<string[]>(props.selectedPath ? [props.selectedPath] : [])

watch(
  () => props.selectedPath,
  (path) => {
    if (path) selectedKeys.value = [path]
  }
)

function onSelect(keys: (string | number)[]): void {
  // antd 点已选中节点会反选成空,忽略这种"取消",保持原选中
  if (keys.length === 0) return
  const key = String(keys[0])
  selectedKeys.value = [key]
  if (typeOf.value.get(key) === 'file') emit('select', key)
}

/** 新建目标:选中的是目录就建在它下面,否则建在根 */
const createBase = computed(() => {
  const key = selectedKeys.value[0]
  return key && typeOf.value.get(key) === 'dir' ? key : ''
})

const entryModal = reactive({ open: false, kind: 'file' as 'file' | 'dir', name: '' })

function openCreate(kind: 'file' | 'dir'): void {
  entryModal.kind = kind
  entryModal.name = ''
  entryModal.open = true
}

function submitCreate(): void {
  const name = entryModal.name.trim().replace(/^\/+|\/+$/g, '')
  if (!name) return
  const path = createBase.value ? `${createBase.value}/${name}` : name
  if (entryModal.kind === 'file') emit('createFile', path)
  else emit('createDir', path)
  entryModal.open = false
}

function confirmRemove(node: TreeNode): void {
  modal.confirm({
    get title() {
      return t('common.delete', node.title)
    },
    content: node.isLeaf
      ? t('messages.theFileWillBePermanentlyDeleted')
      : t('messages.theEntireDirectoryWillBePermanentlyDeleted'),
    okText: t('common.deleteLabel'),
    okButtonProps: { danger: true },
    cancelText: t('common.cancel'),
    onOk: () => emit('remove', node.key)
  })
}
</script>

<template>
  <div class="skill-tree">
    <div class="skill-tree-bar">
      <a-tooltip :title="createBase ? t('messages.newFileIn', createBase) : t('common.newFile')">
        <a-button size="small" type="text" @click="openCreate('file')">
          <template #icon><FileAddOutlined /></template>
        </a-button>
      </a-tooltip>
      <a-tooltip
        :title="createBase ? t('messages.newDirectoryIn', createBase) : t('common.newDirectory')"
      >
        <a-button size="small" type="text" @click="openCreate('dir')">
          <template #icon><FolderAddOutlined /></template>
        </a-button>
      </a-tooltip>
      <a-tooltip :title="t('common.refresh')">
        <a-button size="small" type="text" @click="emit('refresh')">
          <template #icon><ReloadOutlined /></template>
        </a-button>
      </a-tooltip>
    </div>

    <a-empty
      v-if="treeData.length === 0"
      :description="t('messages.emptySkillCreateAFileToGetStarted')"
      style="margin-top: 40px"
    />
    <a-tree
      v-else
      class="skill-tree-view"
      :tree-data="treeData"
      :selected-keys="selectedKeys"
      :expanded-keys="expandedKeys"
      block-node
      @expand="(keys: (string | number)[]) => (expandedKeys = keys.map(String))"
      @select="onSelect"
    >
      <template #titleRender="node">
        <span class="skill-node">
          <FileOutlined v-if="(node as unknown as TreeNode).isLeaf" />
          <FolderOpenOutlined
            v-else-if="expandedKeys.includes((node as unknown as TreeNode).key)"
          />
          <FolderOutlined v-else />
          <span class="skill-node-title">{{ (node as unknown as TreeNode).title }}</span>
          <span class="skill-node-del" @click.stop="confirmRemove(node as unknown as TreeNode)">
            <DeleteOutlined />
          </span>
        </span>
      </template>
    </a-tree>

    <a-modal
      v-model:open="entryModal.open"
      :title="entryModal.kind === 'file' ? t('common.newFile') : t('common.newDirectory')"
      :ok-text="t('common.create')"
      @ok="submitCreate"
    >
      <a-form layout="vertical" style="margin-top: 8px">
        <a-form-item
          :label="
            createBase
              ? t('common.createIn', createBase)
              : t('messages.createInTheSkillRootDirectory')
          "
        >
          <a-input
            v-model:value="entryModal.name"
            :placeholder="
              entryModal.kind === 'file'
                ? t('common.eGReferencesNotesMd')
                : t('common.eGReferences')
            "
            @press-enter="submitCreate"
          />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.skill-tree {
  height: 100%;
  overflow: auto;
  padding: 4px;
}

.skill-tree-bar {
  display: flex;
  gap: 2px;
  padding: 2px 4px 6px;
}

/*
 * 收窄缩进与折叠箭头,以及让省略号真的能生效。
 * 抄自 pages/project/components/FileTree.vue,原因见那边的注释:
 * antd 默认尺寸是给宽面板用的;flex 链上不逐层清 min-width,长文件名
 * 会把整行顶宽、树横向溢出。
 */
.skill-tree-view :deep(.ant-tree-indent-unit) {
  width: 12px;
}

.skill-tree-view :deep(.ant-tree-switcher) {
  width: 18px;
  line-height: inherit;
}

.skill-tree-view :deep(.ant-tree-treenode) {
  max-width: 100%;
}

.skill-tree-view :deep(.ant-tree-node-content-wrapper) {
  min-width: 0;
  overflow: hidden;
}

.skill-tree-view :deep(.ant-tree-title) {
  display: block;
  min-width: 0;
  overflow: hidden;
}

.skill-node {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}

.skill-node-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 删除入口 hover 才出现:常驻的话每行一个垃圾桶,树看着像回收站 */
.skill-node-del {
  display: none;
  margin-left: 4px;
  opacity: 0.6;
}

.skill-node-del:hover {
  opacity: 1;
}

.skill-node:hover .skill-node-del {
  display: inline-flex;
}
</style>
