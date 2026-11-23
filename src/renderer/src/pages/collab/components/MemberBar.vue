<script setup lang="ts">
import { t, activityLabel } from '@renderer/i18n'
import { theme } from 'antdv-next'
import { CheckOutlined, CloseOutlined, LoadingOutlined } from '@antdv-next/icons'
import { useCollabStore } from '@renderer/stores/collab'
import WorkspaceRoots from '../../project/components/WorkspaceRoots.vue'
import RoleAvatar from './RoleAvatar.vue'
import DeliverablePanel from './DeliverablePanel.vue'
import type { GroupActivity } from '@renderer/stores/collab'
import type { GroupRoleMeta } from '@shared/types'

/**
 * 群头部的成员条:一排角色头像,正在发言的带呼吸光环。
 *
 * 点头像开抽屉看这个角色的"底牌":职责、产出物、当前状态,以及**本轮注入
 * 的完整提示词**。提示词必须能看到——多 agent 编排里模型行为的大头来自注入,
 * 藏起来的话用户没法理解"为什么产品经理会这么说"。
 */

const { token } = theme.useToken()
const collab = useCollabStore()

const drawerOpen = ref(false)
const drawerRole = ref<GroupRoleMeta | null>(null)

function openRole(role: GroupRoleMeta): void {
  drawerRole.value = role
  drawerOpen.value = true
}

/**
 * 该角色最近一条发言。注入提示词与工具活动都按消息 id 挂着,
 * 抽屉展示"本轮"的,取最新那条即可。
 */
const latestMessage = computed(() => {
  const role = drawerRole.value
  if (!role) return null
  return [...collab.messages].reverse().find((m) => m.author === role.id) ?? null
})

const drawerActivities = computed<GroupActivity[]>(() =>
  latestMessage.value ? (collab.activities[latestMessage.value.id] ?? []) : []
)

const drawerSystem = computed(() =>
  latestMessage.value ? (collab.systemPrompts[latestMessage.value.id] ?? '') : ''
)

const drawerSpeaking = computed(
  () => drawerRole.value != null && collab.speakingAuthors.includes(drawerRole.value.id)
)

const activeStates = new Set(['preparing', 'executing'])

const statusText = computed(() => {
  if (!drawerSpeaking.value) return t('空闲')
  return drawerActivities.value.some((a) => activeStates.has(a.state))
    ? t('正在调用工具')
    : t('正在输出')
})
</script>

<template>
  <div class="member-bar" :style="{ borderColor: token.colorBorderSecondary }">
    <a-tooltip
      v-for="role in collab.memberRoles"
      :key="role.id"
      :title="`${role.name} · ${role.duty}`"
    >
      <button type="button" class="member-btn" @click="openRole(role)">
        <!-- 并行接力时同时有几位在说话,呼吸光环也就同时亮几个 -->
        <RoleAvatar :role="role" :speaking="collab.speakingAuthors.includes(role.id)" />
      </button>
    </a-tooltip>

    <!-- 交付物清单:这个群**产出了什么**,和"能动用什么"分开 -->
    <span class="member-divider" :style="{ background: token.colorBorderSecondary }" />
    <DeliverablePanel />

    <!-- 目录授权和成员放一起:都是"这个群能动用什么"的范畴 -->
    <span class="member-divider" :style="{ background: token.colorBorderSecondary }" />
    <WorkspaceRoots
      v-if="collab.conversationId"
      :scope="{ conversationId: collab.conversationId }"
    />

    <a-drawer v-model:open="drawerOpen" :title="drawerRole?.name" size="large">
      <div v-if="drawerRole" class="role-drawer">
        <div class="role-head">
          <RoleAvatar :role="drawerRole" :size="40" :speaking="drawerSpeaking" />
          <div class="role-head-text">
            <div class="role-duty">{{ drawerRole.duty }}</div>
            <div class="role-deliverable" :style="{ color: token.colorTextTertiary }">
              {{ t('产出物:') }}{{ drawerRole.deliverable }}
            </div>
          </div>
        </div>

        <div class="role-section-title" :style="{ color: token.colorTextTertiary }">
          {{ t('当前状态') }}
        </div>
        <div class="role-status">
          <LoadingOutlined v-if="drawerSpeaking" spin :style="{ color: token.colorPrimary }" />
          <span>{{ statusText }}</span>
        </div>
        <div v-if="drawerActivities.length" class="role-activities">
          <div v-for="item in drawerActivities" :key="item.callId" class="role-activity-row">
            <span class="role-activity-icon">
              <LoadingOutlined v-if="activeStates.has(item.state)" spin />
              <CheckOutlined
                v-else-if="item.state === 'success'"
                :style="{ color: token.colorSuccess }"
              />
              <CloseOutlined
                v-else
                :style="{
                  color: item.state === 'recoverable_error' ? token.colorWarning : token.colorError
                }"
              />
            </span>
            <span class="role-activity-label">{{ activityLabel(item.label) }}</span>
            <span
              v-if="item.summary"
              class="role-activity-summary"
              :style="{
                color: item.state === 'fatal_error' ? token.colorError : token.colorTextTertiary
              }"
            >
              {{ activityLabel(item.summary) }}
            </span>
          </div>
        </div>

        <div class="role-section-title" :style="{ color: token.colorTextTertiary }">
          {{ t('本轮注入的提示词') }}
        </div>
        <!-- pre 自己封顶滚动:注入提示词动辄几千字,不封顶抽屉整个被它撑走 -->
        <pre
          v-if="drawerSystem"
          class="role-system"
          :style="{
            borderColor: token.colorBorderSecondary,
            background: token.colorFillQuaternary
          }"
          >{{ drawerSystem }}</pre>
        <div v-else class="role-system-empty" :style="{ color: token.colorTextQuaternary }">
          {{ t('这个角色本轮还没有发言。它被 @ 到时,这里会显示注入给它的完整提示词。') }}
        </div>
      </div>
    </a-drawer>
  </div>
</template>

<style scoped>
.member-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 0 10px;
  border-bottom: 1px solid;
  flex-shrink: 0;
}

.member-btn {
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
  display: inline-flex;
  border-radius: 50%;
}

.member-divider {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  flex-shrink: 0;
}

.role-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
}

.role-head-text {
  min-width: 0;
}

.role-duty {
  font-size: 13px;
  line-height: 1.6;
}

.role-deliverable {
  font-size: 12px;
  margin-top: 2px;
}

.role-section-title {
  font-size: 12px;
  font-weight: 600;
  margin: 14px 0 6px;
}

.role-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.role-activities {
  margin-top: 6px;
  padding-left: 4px;
  border-left: 1px solid var(--app-border);
}

.role-activity-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 2px 0 2px 8px;
  font-size: 12px;
  line-height: 1.7;
}

.role-activity-icon {
  flex-shrink: 0;
  font-size: 10px;
  width: 12px;
}

.role-activity-label {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.role-activity-summary {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 55%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
}

/* 注入提示词:等宽、保留换行、内部滚动。抽屉再大也装不下整份 system */
.role-system {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid;
  border-radius: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 48vh;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.role-system-empty {
  font-size: 12px;
  line-height: 1.7;
}
</style>
