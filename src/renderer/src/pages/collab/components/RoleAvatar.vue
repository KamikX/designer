<script setup lang="ts">
import type { GroupRoleMeta } from '@shared/types'

/**
 * 角色圆形头像:role.color 底色 + 名字首字。
 *
 * speaking 时套一圈同色呼吸光环——群里同时只有一个角色在发言,成员条上
 * 一排头像,靠这圈光让用户一眼定位到"现在是谁在说"。
 */

const props = defineProps<{
  role: GroupRoleMeta | null
  /** 直径,默认 28 */
  size?: number
  /** 正在发言:呼吸光环 */
  speaking?: boolean
}>()

const diameter = computed(() => props.size ?? 28)
const color = computed(() => props.role?.color ?? '#8c8c8c')
</script>

<template>
  <span
    class="role-avatar"
    :class="{ 'role-avatar--speaking': speaking }"
    :style="{
      background: color,
      width: `${diameter}px`,
      height: `${diameter}px`,
      fontSize: `${Math.round(diameter * 0.44)}px`,
      // 光环颜色跟头像同源,透明度压低避免抢过内容区
      '--role-ring': `color-mix(in srgb, ${color} 45%, transparent)`
    }"
  >
    {{ role?.name?.[0] ?? '?' }}
  </span>
</template>

<style scoped>
.role-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #fff;
  flex-shrink: 0;
  user-select: none;
  line-height: 1;
}

.role-avatar--speaking {
  animation: role-breathe 1.4s ease-in-out infinite;
}

@keyframes role-breathe {
  0%,
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
  50% {
    box-shadow: 0 0 0 5px var(--role-ring);
  }
}
</style>
