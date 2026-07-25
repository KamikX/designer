<script setup lang="ts">
import { theme } from 'antdv-next'

const { token } = theme.useToken()
</script>

<template>
  <div class="page-pad">
    <a-card title="组件" :style="{ background: token.colorBgContainer }">
      <a-space wrap>
        <a-button type="primary">主要按钮</a-button>
        <a-button>默认按钮</a-button>
        <a-tag color="blue">标签</a-tag>
        <a-switch default-checked />
      </a-space>
    </a-card>
  </div>
</template>

<style scoped>
/* 页面自己的边距,见 layouts/default 里 --page-pad 的说明 */
.page-pad {
  padding: 0 var(--page-pad) var(--page-pad);
}
</style>
