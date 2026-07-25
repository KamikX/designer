<script setup lang="ts">
import {
  LoadingOutlined,
  FileOutlined,
  FolderOutlined,
  FolderOpenOutlined
} from '@antdv-next/icons'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useProjectStore } from '@renderer/stores/project'
import { exportDirName, sanitizeName } from '@shared/export-name'

/**
 * 文件树。流式期间未完成的文件节点带转圈图标。
 *
 * 顶上挂一个根节点,名字是**导出时真实的目录名**(项目名-v版本号,规则在
 * shared/export-name)。这样树上看到的结构和导出到磁盘上的结构是同一个,
 * 不用在脑子里做一次映射;顺带也让只有一两个文件的树不至于空得发慌。
 */

const store = useArtifactStore()
const projectStore = useProjectStore()

/** 根节点的 key。不是真实路径,选中它不该切文件 */
const ROOT_KEY = '/__export_root__'

interface TreeNode {
  key: string
  title: string
  isLeaf: boolean
  loading?: boolean
  children?: TreeNode[]
}

const rootTitle = computed(() => {
  const name = projectStore.current?.name
  const version = store.current?.version
  // 版本还没落库时版本号未知,先只显示项目名——不要瞎猜一个 v 号
  return version ? exportDirName(name, version) : sanitizeName(name ?? '')
})

/** 所有文件路径,用来判断一个 key 是不是可选中的叶子 */
const filePaths = computed(() => new Set(store.displayFiles.map((f) => f.path)))

const treeData = computed<TreeNode[]>(() => {
  const root: TreeNode[] = []
  for (const file of store.displayFiles) {
    const segments = file.path.split('/')
    let level = root
    let prefix = ''
    for (let i = 0; i < segments.length; i++) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i]
      const isLeaf = i === segments.length - 1
      let node = level.find((n) => n.key === prefix)
      if (!node) {
        node = { key: prefix, title: segments[i], isLeaf, children: isLeaf ? undefined : [] }
        level.push(node)
      }
      if (isLeaf) node.loading = !file.done
      else level = node.children!
    }
  }
  if (root.length === 0) return []
  return [{ key: ROOT_KEY, title: rootTitle.value, isLeaf: false, children: root }]
})

/** 目录节点(含根)的 key,用来控制展开 */
const dirKeys = computed(() => [
  ROOT_KEY,
  ...store.displayFiles.flatMap((f) => {
    const segments = f.path.split('/')
    return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join('/'))
  })
])

/**
 * 展开态。
 *
 * 不用 computed 直接钉死:那样折叠箭头点了没反应。改成新出现的目录自动
 * 并进来——流式期间文件是一点点冒出来的,不自动展开就看不见。代价是手动
 * 折叠会在下次冒出新目录时被重新展开,这个取舍划算。
 */
const expandedKeys = ref<string[]>([ROOT_KEY])

watch(
  dirKeys,
  (keys) => {
    expandedKeys.value = [...new Set([...expandedKeys.value, ...keys])]
  },
  { immediate: true }
)

/** 只有叶子(真实文件)能切换选中——点目录或根节点不该把代码区弄空 */
function onSelect(keys: (string | number)[]): void {
  const key = keys[0] == null ? '' : String(keys[0])
  if (filePaths.value.has(key)) store.selectedPath = key
}
</script>

<template>
  <a-tree
    class="file-tree-view"
    :tree-data="treeData"
    :selected-keys="[store.selectedPath]"
    :expanded-keys="expandedKeys"
    block-node
    @expand="(keys: (string | number)[]) => (expandedKeys = keys.map(String))"
    @select="onSelect"
  >
    <template #titleRender="node">
      <span class="file-node">
        <LoadingOutlined v-if="(node as unknown as TreeNode).loading" spin />
        <FileOutlined v-else-if="(node as unknown as TreeNode).isLeaf" />
        <FolderOpenOutlined v-else-if="expandedKeys.includes((node as unknown as TreeNode).key)" />
        <FolderOutlined v-else />
        <span class="file-node-title">{{ (node as unknown as TreeNode).title }}</span>
      </span>
    </template>
  </a-tree>
</template>

<style scoped>
/*
 * 收窄缩进与折叠箭头。
 *
 * antd 的默认值(每级 24px、箭头 24px)是给文件管理器那种深层级树用的;
 * 我们这棵树通常只有两三层、面板又只有 168px 宽,照默认走的话光缩进就吃
 * 掉一半宽度,文件名全被省略号截断。
 *
 * 只调这两个尺寸,不自己实现一棵树:选中态、键盘导航、无障碍属性都在
 * a-tree 里,为了缩进重写一遍不划算。
 */
.file-tree-view :deep(.ant-tree-indent-unit) {
  width: 12px;
}

.file-tree-view :deep(.ant-tree-switcher) {
  width: 18px;
  line-height: inherit;
}

/*
 * 让省略号真的能生效。
 *
 * .file-node-title 早就写了 text-overflow: ellipsis,但一直没机会触发:
 * antd 这条 flex 链(treenode → content-wrapper → title)上没有 min-width: 0,
 * 于是每一层的最小宽度都由内容撑着,长文件名把整行顶宽,树横向溢出——
 * 表现就是"容器的 padding 好像没生效"。
 *
 * flex 项的默认 min-width 是 auto(= 内容宽度),必须逐层显式清零,漏一层
 * 都不行。
 */
.file-tree-view :deep(.ant-tree-treenode) {
  max-width: 100%;
}

.file-tree-view :deep(.ant-tree-node-content-wrapper) {
  min-width: 0;
  overflow: hidden;
}

.file-tree-view :deep(.ant-tree-title) {
  display: block;
  min-width: 0;
  overflow: hidden;
}

.file-node {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  max-width: 100%;
}

/* 名字长了就省略,不要把树撑出横向滚动条 */
.file-node-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
