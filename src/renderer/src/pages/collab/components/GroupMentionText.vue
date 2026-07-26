<script setup lang="ts">
import { tokenizeGroupMentions } from '@shared/group-mentions'
import type { GroupRoleMeta } from '@shared/types'
import GroupMentionTag from './GroupMentionTag.vue'

const props = defineProps<{
  content: string
  members: readonly GroupRoleMeta[]
}>()

const tokens = computed(() => tokenizeGroupMentions(props.content, props.members))
const membersById = computed(
  () => new Map(props.members.map((member) => [member.id, member] as const))
)
</script>

<template>
  <span class="group-mention-text">
    <template v-for="(token, index) in tokens" :key="index">
      <GroupMentionTag
        v-if="token.type === 'member'"
        :member="membersById.get(token.memberId) ?? null"
        :fallback-name="token.name"
      />
      <template v-else>{{ token.text }}</template>
    </template>
  </span>
</template>

<style scoped>
.group-mention-text {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
