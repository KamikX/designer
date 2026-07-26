<script setup lang="ts">
import type { ComputedRef, InjectionKey } from 'vue'
import type { GroupRoleMeta } from '@shared/types'
import GroupMentionTag from './GroupMentionTag.vue'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  href?: string
  title?: string
}>()

const groupMentionMembersKey = Symbol.for('group-mention-members') as InjectionKey<
  ComputedRef<readonly GroupRoleMeta[]>
>
const members = inject(groupMentionMembersKey)
const member = computed<GroupRoleMeta | null>(() => {
  if (!props.href?.startsWith('group-member:')) return null
  const memberId = props.href.slice('group-member:'.length)
  return members?.value.find((item) => item.id === memberId) ?? null
})
const isMemberLink = computed(() => props.href?.startsWith('group-member:') === true)

const safeHref = computed(() => {
  const href = props.href?.trim()
  if (!href || isMemberLink.value) return null
  if (
    href.startsWith('#') ||
    href.startsWith('/') ||
    href.startsWith('./') ||
    href.startsWith('../')
  ) {
    return href
  }

  try {
    const protocol = new URL(href).protocol
    return ['http:', 'https:', 'mailto:', 'tel:'].includes(protocol) ? href : null
  } catch {
    return null
  }
})

const opensNewWindow = computed(
  () => safeHref.value?.startsWith('http://') || safeHref.value?.startsWith('https://')
)
</script>

<template>
  <GroupMentionTag v-if="member" :member="member" />
  <span v-else-if="isMemberLink"><slot /></span>
  <a
    v-else-if="safeHref"
    :href="safeHref"
    :title="title"
    :target="opensNewWindow ? '_blank' : undefined"
    :rel="opensNewWindow ? 'noopener noreferrer' : undefined"
  >
    <slot />
  </a>
  <span v-else><slot /></span>
</template>
