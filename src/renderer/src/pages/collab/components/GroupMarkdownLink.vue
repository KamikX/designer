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

const safeLink = computed<{ href: string; external: boolean } | null>(() => {
  const href = props.href?.trim()
  if (!href || isMemberLink.value) return null
  if (href.startsWith('#')) return { href, external: false }

  try {
    const url = new URL(href)
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return null
    return { href: url.href, external: true }
  } catch {
    return null
  }
})
</script>

<template>
  <GroupMentionTag v-if="member" :member="member" />
  <span v-else-if="isMemberLink"><slot /></span>
  <a
    v-else-if="safeLink"
    :href="safeLink.href"
    :title="title"
    :target="safeLink.external ? '_blank' : undefined"
    :rel="safeLink.external ? 'noopener noreferrer' : undefined"
  >
    <slot />
  </a>
  <span v-else><slot /></span>
</template>
