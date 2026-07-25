<script setup lang="ts">
import { LoadingOutlined, FileOutlined, FolderOutlined } from '@antdv-next/icons'
import { useArtifactStore } from '@renderer/stores/artifact'

/** 文件树。流式期间未完成的文件节点带转圈图标。 */

const store = useArtifactStore()

interface TreeNode {
  key: string
  title: string
  isLeaf: boolean
  loading?: boolean
  children?: TreeNode[]
}

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
  return root
})

// 目录默认全展开:设计稿层级浅,收起来反而多一步
const expandedKeys = computed(() =>
  store.displayFiles.flatMap((f) => {
    const segments = f.path.split('/')
    return segments.slice(0, -1).map((_, i) => segments.slice(0, i + 1).join('/'))
  })
)
</script>

<template>
  <a-tree
    :tree-data="treeData"
    :selected-keys="[store.selectedPath]"
    :expanded-keys="expandedKeys"
    block-node
    @select="(keys: (string | number)[]) => keys[0] && (store.selectedPath = String(keys[0]))"
  >
    <template #titleRender="node">
      <span style="display: inline-flex; align-items: center; gap: 4px">
        <LoadingOutlined v-if="(node as unknown as TreeNode).loading" spin />
        <FileOutlined v-else-if="(node as unknown as TreeNode).isLeaf" />
        <FolderOutlined v-else />
        {{ (node as unknown as TreeNode).title }}
      </span>
    </template>
  </a-tree>
</template>
