<script setup lang="ts">
import { t } from '@renderer/i18n'
const router = useRouter()
</script>

<template>
  <div class="page-pad">
    <a-result status="404" title="404" :sub-title="t('common.pageNotFound')">
      <template #extra>
        <a-button type="primary" @click="router.replace('/')">{{
          t('common.backToHome')
        }}</a-button>
      </template>
    </a-result>
  </div>
</template>

<style scoped>
/* 页面自己的边距,见 layouts/default 里 --page-pad 的说明 */
.page-pad {
  padding: 0 var(--page-pad) var(--page-pad);
}
</style>
