<script setup lang="ts">
import { t } from '@renderer/i18n'
import type { TranslationKey } from '@shared/i18n'
import type { DesignMode, DesignTarget, Stack } from '@shared/types'

defineProps<{ stack: Stack; designMode: DesignMode; targets: DesignTarget[] | null }>()

const stackLabels: Record<Stack, string> = { html: 'HTML', vue3: 'Vue 3', react: 'React' }

const modeLabels: Record<DesignMode, TranslationKey> = {
  design: 'common.highQualityUiDesign',
  prototype: 'common.rapidPrototype'
}

const targetLabels: Record<DesignTarget, TranslationKey> = {
  landing: 'common.landingPage',
  web: 'common.webApplication',
  mobile: 'common.mobileApp',
  admin: 'common.adminDashboard',
  components: 'common.componentDevelopment'
}
</script>

<template>
  <div class="project-tags">
    <a-tag>{{ stackLabels[stack] }}</a-tag>
    <a-tag>{{ t(modeLabels[designMode]) }}</a-tag>
    <a-tag v-for="target in targets ?? []" :key="target">{{ t(targetLabels[target]) }}</a-tag>
  </div>
</template>

<style scoped>
.project-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.project-tags :deep(.ant-tag) {
  margin: 0;
  max-width: 100%;
  white-space: normal;
  overflow-wrap: anywhere;
  cursor: inherit;
}
</style>
