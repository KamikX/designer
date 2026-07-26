<template>
  <a-form :model="form" :rules="rules" layout="vertical">
    <a-form-item label="角色名" name="name"><a-input v-model:value="form.name" /></a-form-item>
    <a-form-item label="描述" name="desc"><a-textarea v-model:value="form.desc" /></a-form-item>
  </a-form>
</template>

<script setup>
const form = reactive({ name: '', desc: '' })
const rules = {name0: [{ required: true, message: '必填项 0', trigger: 'blur' }], name1: [{ required: true, message: '必填项 1', trigger: 'blur' }], name2: [{ required: true, message: '必填项 2', trigger: 'blur' }], name3: [{ required: true, message: '必填项 3', trigger: 'blur' }], name4: [{ required: true, message: '必填项 4', trigger: 'blur' }], name5: [{ required: true, message: '必填项 5', trigger: 'blur' }], name6: [{ required: true, message: '必填项 6', trigger: 'blur' }], name7: [{ required: true, message: '必填项 7', trigger: 'blur' }], name8: [{ required: true, message: '必填项 8', trigger: 'blur' }], name9: [{ required: true, message: '必填项 9', trigger: 'blur' }], name10: [{ required: true, message: '必填项 10', trigger: 'blur' }], name11: [{ required: true, message: '必填项 11', trigger: 'blur' }], name12: [{ required: true, message: '必填项 12', trigger: 'blur' }], }
function submit() {
  return api.saveRole({ ...form })
}
</script>
<!-- 表单说明 0 -->
<!-- 表单说明 1 -->
<!-- 表单说明 2 -->
<!-- 表单说明 3 -->
<!-- 表单说明 4 -->
<!-- 表单说明 5 -->
<!-- 表单说明 6 -->
<!-- 表单说明 7 -->
<!-- 表单说明 8 -->
<!-- 表单说明 9 -->
<!-- 表单说明 10 -->
<!-- 表单说明 11 -->
<!-- 表单说明 12 -->
<!-- 表单说明 13 -->
<!-- 表单说明 14 -->
<!-- 表单说明 15 -->
<!-- 表单说明 16 -->
<!-- 表单说明 17 -->
<!-- 表单说明 18 -->
<!-- 表单说明 19 -->
<!-- 表单说明 20 -->
<!-- 表单说明 21 -->
<!-- 表单说明 22 -->
<!-- 表单说明 23 -->
<!-- 表单说明 24 -->
<!-- 表单说明 25 -->
<!-- 表单说明 26 -->
<!-- 表单说明 27 -->
<!-- 表单说明 28 -->
<!-- 表单说明 29 -->
