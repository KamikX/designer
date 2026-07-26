<template>
  <a-tree checkable :tree-data="treeData" v-model:checked-keys="checkedKeys">
    <template #titleRender="{ title }">{{ title }}</template>
  </a-tree>
</template>

<script setup>
const checkedKeys = ref([])
const treeData = ref([
  { title: '模块 0', key: 'mod-0', children: [{ title: '读取', key: 'mod-0-read' }, { title: '写入', key: 'mod-0-write' }] },
  { title: '模块 1', key: 'mod-1', children: [{ title: '读取', key: 'mod-1-read' }, { title: '写入', key: 'mod-1-write' }] },
  { title: '模块 2', key: 'mod-2', children: [{ title: '读取', key: 'mod-2-read' }, { title: '写入', key: 'mod-2-write' }] },
  { title: '模块 3', key: 'mod-3', children: [{ title: '读取', key: 'mod-3-read' }, { title: '写入', key: 'mod-3-write' }] },
  { title: '模块 4', key: 'mod-4', children: [{ title: '读取', key: 'mod-4-read' }, { title: '写入', key: 'mod-4-write' }] },
  { title: '模块 5', key: 'mod-5', children: [{ title: '读取', key: 'mod-5-read' }, { title: '写入', key: 'mod-5-write' }] },
  { title: '模块 6', key: 'mod-6', children: [{ title: '读取', key: 'mod-6-read' }, { title: '写入', key: 'mod-6-write' }] },
  { title: '模块 7', key: 'mod-7', children: [{ title: '读取', key: 'mod-7-read' }, { title: '写入', key: 'mod-7-write' }] },
  { title: '模块 8', key: 'mod-8', children: [{ title: '读取', key: 'mod-8-read' }, { title: '写入', key: 'mod-8-write' }] },
  { title: '模块 9', key: 'mod-9', children: [{ title: '读取', key: 'mod-9-read' }, { title: '写入', key: 'mod-9-write' }] },
  { title: '模块 10', key: 'mod-10', children: [{ title: '读取', key: 'mod-10-read' }, { title: '写入', key: 'mod-10-write' }] },
  { title: '模块 11', key: 'mod-11', children: [{ title: '读取', key: 'mod-11-read' }, { title: '写入', key: 'mod-11-write' }] },
  { title: '模块 12', key: 'mod-12', children: [{ title: '读取', key: 'mod-12-read' }, { title: '写入', key: 'mod-12-write' }] },
  { title: '模块 13', key: 'mod-13', children: [{ title: '读取', key: 'mod-13-read' }, { title: '写入', key: 'mod-13-write' }] },
  { title: '模块 14', key: 'mod-14', children: [{ title: '读取', key: 'mod-14-read' }, { title: '写入', key: 'mod-14-write' }] },
  { title: '模块 15', key: 'mod-15', children: [{ title: '读取', key: 'mod-15-read' }, { title: '写入', key: 'mod-15-write' }] },
  { title: '模块 16', key: 'mod-16', children: [{ title: '读取', key: 'mod-16-read' }, { title: '写入', key: 'mod-16-write' }] },
  { title: '模块 17', key: 'mod-17', children: [{ title: '读取', key: 'mod-17-read' }, { title: '写入', key: 'mod-17-write' }] },
  { title: '模块 18', key: 'mod-18', children: [{ title: '读取', key: 'mod-18-read' }, { title: '写入', key: 'mod-18-write' }] },
  { title: '模块 19', key: 'mod-19', children: [{ title: '读取', key: 'mod-19-read' }, { title: '写入', key: 'mod-19-write' }] },
  { title: '模块 20', key: 'mod-20', children: [{ title: '读取', key: 'mod-20-read' }, { title: '写入', key: 'mod-20-write' }] },
  { title: '模块 21', key: 'mod-21', children: [{ title: '读取', key: 'mod-21-read' }, { title: '写入', key: 'mod-21-write' }] },
  { title: '模块 22', key: 'mod-22', children: [{ title: '读取', key: 'mod-22-read' }, { title: '写入', key: 'mod-22-write' }] },
  { title: '模块 23', key: 'mod-23', children: [{ title: '读取', key: 'mod-23-read' }, { title: '写入', key: 'mod-23-write' }] },
])
</script>
<!-- 权限树注释 0 -->
<!-- 权限树注释 1 -->
<!-- 权限树注释 2 -->
<!-- 权限树注释 3 -->
<!-- 权限树注释 4 -->
<!-- 权限树注释 5 -->
<!-- 权限树注释 6 -->
<!-- 权限树注释 7 -->
<!-- 权限树注释 8 -->
<!-- 权限树注释 9 -->
<!-- 权限树注释 10 -->
<!-- 权限树注释 11 -->
<!-- 权限树注释 12 -->
<!-- 权限树注释 13 -->
<!-- 权限树注释 14 -->
<!-- 权限树注释 15 -->
<!-- 权限树注释 16 -->
<!-- 权限树注释 17 -->
<!-- 权限树注释 18 -->
<!-- 权限树注释 19 -->
<!-- 权限树注释 20 -->
<!-- 权限树注释 21 -->
<!-- 权限树注释 22 -->
<!-- 权限树注释 23 -->
<!-- 权限树注释 24 -->
<!-- 权限树注释 25 -->
<!-- 权限树注释 26 -->
<!-- 权限树注释 27 -->
<!-- 权限树注释 28 -->
<!-- 权限树注释 29 -->
