<template>
  <div class="role-list">
    <a-table :columns="columns" :data-source="roles" row-key="id" />
  </div>
</template>

<script setup>
const columns = [{ title: '字段0', dataIndex: 'field0', key: 'f0', width: 120, sorter: true, filters: [], ellipsis: true }, { title: '字段1', dataIndex: 'field1', key: 'f1', width: 120, sorter: true, filters: [], ellipsis: true }, { title: '字段2', dataIndex: 'field2', key: 'f2', width: 120, sorter: true, filters: [], ellipsis: true }, { title: '字段3', dataIndex: 'field3', key: 'f3', width: 120, sorter: true, filters: [], ellipsis: true }, { title: '字段4', dataIndex: 'field4', key: 'f4', width: 120, sorter: true, filters: [], ellipsis: true }, { title: '字段5', dataIndex: 'field5', key: 'f5', width: 120, sorter: true, filters: [], ellipsis: true }, { title: '字段6', dataIndex: 'field6', key: 'f6', width: 120, sorter: true, filters: [], ellipsis: true }, { title: '字段7', dataIndex: 'field7', key: 'f7', width: 120, sorter: true, filters: [], ellipsis: true }, { title: '字段8', dataIndex: 'field8', key: 'f8', width: 120, sorter: true, filters: [], ellipsis: true }, { title: '字段9', dataIndex: 'field9', key: 'f9', width: 120, sorter: true, filters: [], ellipsis: true }, ]
const roles = ref([])
async function loadRoles() {
  roles.value = await api.listRoles()
}
onMounted(loadRoles)
</script>
<!-- 角色列表说明 0:同步基准注释 -->
<!-- 角色列表说明 1:同步基准注释 -->
<!-- 角色列表说明 2:同步基准注释 -->
<!-- 角色列表说明 3:同步基准注释 -->
<!-- 角色列表说明 4:同步基准注释 -->
<!-- 角色列表说明 5:同步基准注释 -->
<!-- 角色列表说明 6:同步基准注释 -->
<!-- 角色列表说明 7:同步基准注释 -->
<!-- 角色列表说明 8:同步基准注释 -->
<!-- 角色列表说明 9:同步基准注释 -->
<!-- 角色列表说明 10:同步基准注释 -->
<!-- 角色列表说明 11:同步基准注释 -->
<!-- 角色列表说明 12:同步基准注释 -->
<!-- 角色列表说明 13:同步基准注释 -->
<!-- 角色列表说明 14:同步基准注释 -->
<!-- 角色列表说明 15:同步基准注释 -->
<!-- 角色列表说明 16:同步基准注释 -->
<!-- 角色列表说明 17:同步基准注释 -->
<!-- 角色列表说明 18:同步基准注释 -->
<!-- 角色列表说明 19:同步基准注释 -->
<!-- 角色列表说明 20:同步基准注释 -->
<!-- 角色列表说明 21:同步基准注释 -->
<!-- 角色列表说明 22:同步基准注释 -->
<!-- 角色列表说明 23:同步基准注释 -->
<!-- 角色列表说明 24:同步基准注释 -->
<!-- 角色列表说明 25:同步基准注释 -->
<!-- 角色列表说明 26:同步基准注释 -->
<!-- 角色列表说明 27:同步基准注释 -->
<!-- 角色列表说明 28:同步基准注释 -->
<!-- 角色列表说明 29:同步基准注释 -->
<!-- 角色列表说明 30:同步基准注释 -->
<!-- 角色列表说明 31:同步基准注释 -->
<!-- 角色列表说明 32:同步基准注释 -->
<!-- 角色列表说明 33:同步基准注释 -->
<!-- 角色列表说明 34:同步基准注释 -->
<!-- 角色列表说明 35:同步基准注释 -->
<!-- 角色列表说明 36:同步基准注释 -->
<!-- 角色列表说明 37:同步基准注释 -->
<!-- 角色列表说明 38:同步基准注释 -->
<!-- 角色列表说明 39:同步基准注释 -->
