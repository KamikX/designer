<script setup lang="ts">
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
      @click="emit('edit', member.tempKey)"
    >
      <RoleAvatar :role="{ ...member, id: member.tempKey }" :size="28" />
      <div class="member-card-copy">
        <div class="member-card-name">{{ member.name || '未命名成员' }}</div>
        <div class="member-card-duty" :style="{ color: token.colorTextTertiary }">
          {{ member.duty || '尚未填写职责' }}
        </div>
      </div>
      <div class="member-card-actions">
        <a-button
          :data-testid="`edit-${member.tempKey}`"
          type="text"
          size="small"
          aria-label="编辑成员"
          @click.stop="emit('edit', member.tempKey)"
        >
          <template #icon><EditOutlined /></template>
        </a-button>
        <a-button
          :data-testid="`move-up-${member.tempKey}`"
          type="text"
          size="small"
          aria-label="上移成员"
          :disabled="index === 0"
          @click.stop="emit('move', member.tempKey, 'up')"
        >
          <template #icon><ArrowUpOutlined /></template>
        </a-button>
        <a-button
          :data-testid="`move-down-${member.tempKey}`"
          type="text"
          size="small"
          aria-label="下移成员"
          :disabled="index === props.members.length - 1"
          @click.stop="emit('move', member.tempKey, 'down')"
        >
          <template #icon><ArrowDownOutlined /></template>
        </a-button>
        <a-button
          :data-testid="`remove-${member.tempKey}`"
          type="text"
          size="small"
          danger
          aria-label="删除成员"
          @click.stop="emit('remove', member.tempKey)"
        >
          <template #icon><DeleteOutlined /></template>
        </a-button>
      </div>
    </div>
  </div>
  <a-empty v-else :image-style="{ height: '36px' }" description="从模板添加，或创建空白成员" />
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
  cursor: pointer;
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
