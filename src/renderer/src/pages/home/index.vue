<script setup lang="ts">
import { theme } from 'antdv-next'

const { token } = theme.useToken()
</script>

<template>
  <a-space vertical :size="16" style="width: 100%">
    <a-card title="日期" :style="{ background: token.colorBgContainer }">
      <a-space wrap>
        <a-date-picker />
        <a-range-picker />
      </a-space>
    </a-card>
    <a-card title="分页" :style="{ background: token.colorBgContainer }">
      <a-pagination :default-current="1" :total="50" show-size-changer />
    </a-card>
  </a-space>
</template>
