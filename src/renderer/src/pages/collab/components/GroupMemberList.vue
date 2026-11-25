<script setup lang="ts">
import { t } from '@renderer/i18n'
import { theme } from 'antdv-next'
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined } from '@antdv-next/icons'
import RoleAvatar from './RoleAvatar.vue'
import type { MoveDirection, MemberDraft } from '../member-drafts'

const props = defineProps<{ members: readonly MemberDraft[]; activeKey?: string }>()
const emit = defineEmits<{
  edit: [tempKey: string]
  remove: [tempKey: string]
  move: [tempKey: string, direction: MoveDirection]
}>()

const { token } = theme.useToken()
</script>

<template>
  <div v-if="props.members.length" class="member-list">
    <div
      v-for="(member, index) in props.members"
      :key="member.tempKey"
      class="member-card"
      :style="{
        borderColor: activeKey === member.tempKey ? member.color : token.colorBorderSecondary,
        background:
          activeKey === member.tempKey ? token.colorFillQuaternary : token.colorBgContainer
      }"
    >
      <RoleAvatar :role="{ ...member, id: member.tempKey }" :size="28" />
      <div class="member-card-copy">
        <div class="member-card-name">{{ member.name || t('common.unnamedMember') }}</div>
        <div class="member-card-duty" :style="{ color: token.colorTextTertiary }">
          {{ member.duty || t('common.noResponsibilitiesSpecified') }}
        </div>
      </div>
      <div class="member-card-actions">
        <a-button
          :data-testid="`edit-${member.tempKey}`"
          type="text"
          size="small"
          :aria-label="t('common.editMember')"
          @click.stop="emit('edit', member.tempKey)"
        >
          <template #icon><EditOutlined /></template>
        </a-button>
        <a-button
          :data-testid="`move-up-${member.tempKey}`"
          type="text"
          size="small"
          :aria-label="t('common.moveMemberUp')"
          :disabled="index === 0"
          @click.stop="emit('move', member.tempKey, 'up')"
        >
          <template #icon><ArrowUpOutlined /></template>
        </a-button>
        <a-button
          :data-testid="`move-down-${member.tempKey}`"
          type="text"
          size="small"
          :aria-label="t('common.moveMemberDown')"
          :disabled="index === props.members.length - 1"
          @click.stop="emit('move', member.tempKey, 'down')"
        >
          <template #icon><ArrowDownOutlined /></template>
        </a-button>
        <!-- 已有成员没有删除入口:历史消息的 author 引用着 TA 的 ULID -->
        <a-button
          v-if="!member.persistedId"
          :data-testid="`remove-${member.tempKey}`"
          type="text"
          size="small"
          danger
          :aria-label="t('common.deleteMember')"
          @click.stop="emit('remove', member.tempKey)"
        >
          <template #icon><DeleteOutlined /></template>
        </a-button>
      </div>
    </div>
  </div>
  <a-empty
    v-else
    :image-style="{ height: '36px' }"
    :description="t('messages.addFromATemplateOrCreateABlankMember')"
  />
</template>

<style scoped>
.member-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.member-card {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 9px 8px 9px 10px;
  border: 1px solid;
  border-radius: 10px;
}

.member-card-copy {
  min-width: 0;
}

.member-card-name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-card-duty {
  overflow: hidden;
  margin-top: 2px;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.member-card-actions {
  display: flex;
  align-items: center;
}
</style>
