<template>
  <div class="user-table">
    <a-cascader :options="deptOptions" placeholder="选择部门" />
    <a-table :data-source="users" row-key="id" />
  </div>
</template>

<script setup>
const deptOptions = [{ value: 'dept-0', label: '部门 0', children: [{ value: 'team-0', label: '小组 0' }] }, { value: 'dept-1', label: '部门 1', children: [{ value: 'team-1', label: '小组 1' }] }, { value: 'dept-2', label: '部门 2', children: [{ value: 'team-2', label: '小组 2' }] }, { value: 'dept-3', label: '部门 3', children: [{ value: 'team-3', label: '小组 3' }] }, { value: 'dept-4', label: '部门 4', children: [{ value: 'team-4', label: '小组 4' }] }, { value: 'dept-5', label: '部门 5', children: [{ value: 'team-5', label: '小组 5' }] }, { value: 'dept-6', label: '部门 6', children: [{ value: 'team-6', label: '小组 6' }] }, { value: 'dept-7', label: '部门 7', children: [{ value: 'team-7', label: '小组 7' }] }, { value: 'dept-8', label: '部门 8', children: [{ value: 'team-8', label: '小组 8' }] }, { value: 'dept-9', label: '部门 9', children: [{ value: 'team-9', label: '小组 9' }] }, { value: 'dept-10', label: '部门 10', children: [{ value: 'team-10', label: '小组 10' }] }, { value: 'dept-11', label: '部门 11', children: [{ value: 'team-11', label: '小组 11' }] }, { value: 'dept-12', label: '部门 12', children: [{ value: 'team-12', label: '小组 12' }] }, { value: 'dept-13', label: '部门 13', children: [{ value: 'team-13', label: '小组 13' }] }, { value: 'dept-14', label: '部门 14', children: [{ value: 'team-14', label: '小组 14' }] }, { value: 'dept-15', label: '部门 15', children: [{ value: 'team-15', label: '小组 15' }] }, ]
const users = ref([])
const keyword = ref('')
const filtered = computed(() =>
  users.value.filter((u) => u.name.includes(keyword.value))
)
</script>
<!-- 用户表说明 0 -->
<!-- 用户表说明 1 -->
<!-- 用户表说明 2 -->
<!-- 用户表说明 3 -->
<!-- 用户表说明 4 -->
<!-- 用户表说明 5 -->
<!-- 用户表说明 6 -->
<!-- 用户表说明 7 -->
<!-- 用户表说明 8 -->
<!-- 用户表说明 9 -->
<!-- 用户表说明 10 -->
<!-- 用户表说明 11 -->
<!-- 用户表说明 12 -->
<!-- 用户表说明 13 -->
<!-- 用户表说明 14 -->
<!-- 用户表说明 15 -->
<!-- 用户表说明 16 -->
<!-- 用户表说明 17 -->
<!-- 用户表说明 18 -->
<!-- 用户表说明 19 -->
<!-- 用户表说明 20 -->
<!-- 用户表说明 21 -->
<!-- 用户表说明 22 -->
<!-- 用户表说明 23 -->
<!-- 用户表说明 24 -->
<!-- 用户表说明 25 -->
<!-- 用户表说明 26 -->
<!-- 用户表说明 27 -->
<!-- 用户表说明 28 -->
<!-- 用户表说明 29 -->
<!-- 用户表说明 30 -->
<!-- 用户表说明 31 -->
<!-- 用户表说明 32 -->
<!-- 用户表说明 33 -->
<!-- 用户表说明 34 -->
<!-- 用户表说明 35 -->
<!-- 用户表说明 36 -->
<!-- 用户表说明 37 -->
<!-- 用户表说明 38 -->
<!-- 用户表说明 39 -->
