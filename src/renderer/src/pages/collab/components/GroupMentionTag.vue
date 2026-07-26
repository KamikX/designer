<script setup lang="ts">
import type { GroupRoleMeta } from '@shared/types'

const props = defineProps<{
  member: GroupRoleMeta | null
  fallbackName?: string
}>()

const fallbackText = computed(() => `@${props.fallbackName ?? props.member?.name ?? ''}`)
</script>

<template>
  <a-tooltip v-if="member" :title="member.duty || member.name">
    <a-tag class="group-mention-tag" :color="member.color">
      {{ `@${member.name}` }}
    </a-tag>
  </a-tooltip>
  <span v-else>{{ fallbackText }}</span>
</template>

<style scoped>
.group-mention-tag {
  margin-inline-end: 2px;
  padding-inline: 5px;
  line-height: 18px;
  vertical-align: baseline;
}
</style>
