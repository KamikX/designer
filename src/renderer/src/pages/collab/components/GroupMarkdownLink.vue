<script setup lang="ts">
import type { ComputedRef, InjectionKey } from 'vue'
import type { ComarkElement } from 'comark'
import type { GroupRoleMeta } from '@shared/types'
import GroupMentionTag from './GroupMentionTag.vue'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  href?: string
  title?: string
  // eslint-disable-next-line vue/prop-name-casing -- Comark 用这个保留字段传递原始 AST。
  __node?: ComarkElement
}>()

const groupMentionMembersKey = Symbol.for('group-mention-members') as InjectionKey<
  ComputedRef<readonly GroupRoleMeta[]>
>
const members = inject(groupMentionMembersKey)
const member = computed<GroupRoleMeta | null>(() => {
  if (!props.href?.startsWith('group-member:')) return null
  const memberId = props.href.slice('group-member:'.length)
  const candidate = members?.value.find((item) => item.id === memberId)
  if (!candidate) return null

  const node = props.__node
  const children = node?.slice(2) ?? []
  const hasCanonicalLabel =
    node?.[0] === 'a' && children.length === 1 && children[0] === `@${candidate.name}`
  return hasCanonicalLabel ? candidate : null
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
