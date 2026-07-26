<script setup lang="ts">
import { App, theme } from 'antdv-next'
import { PlusOutlined } from '@antdv-next/icons'
import { useCollabStore } from '@renderer/stores/collab'
import { useProviderStore } from '@renderer/stores/provider'
import GroupMemberEditor from './GroupMemberEditor.vue'
import GroupMemberList from './GroupMemberList.vue'
import {
  createBlankMemberDraft,
  createMemberDraftFromTemplate,
  moveMemberDraft,
  removeMemberDraft,
  toGroupMemberDrafts,
  validateMemberDrafts
} from '../member-drafts'
import type { Conversation, GroupMemberTemplate, InstalledSkill } from '@shared/types'
import type { MemberDraft, MoveDirection } from '../member-drafts'

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [group: Conversation] }>()

const { token } = theme.useToken()
const { message } = App.useApp()
const collab = useCollabStore()
const providerStore = useProviderStore()

const name = shallowRef('')
const members = ref<MemberDraft[]>([])
const editingKey = shallowRef('')
const skills = ref<InstalledSkill[]>([])
const creating = shallowRef(false)

const editingMember = computed(() => {
  return members.value.find((member) => member.tempKey === editingKey.value) ?? null
})

watch(
  open,
  (now) => {
    if (!now) return
    name.value = ''
    members.value = []
    editingKey.value = ''
    void loadOptions()
  },
  { immediate: true }
)

async function loadOptions(): Promise<void> {
  try {
    const [, installed] = await Promise.all([
      providerStore.load(),
      window.api.market.installedSkills()
    ])
    skills.value = installed
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

function addTemplate(template: GroupMemberTemplate): void {
  const draft = createMemberDraftFromTemplate(template)
  members.value = [...members.value, draft]
  editingKey.value = draft.tempKey
}

function addBlank(): void {
  const draft = createBlankMemberDraft()
  members.value = [...members.value, draft]
  editingKey.value = draft.tempKey
}

function edit(tempKey: string): void {
  editingKey.value = tempKey
}

function updateMember(member: MemberDraft): void {
  members.value = members.value.map((current) =>
    current.tempKey === member.tempKey ? member : current
  )
}

function remove(tempKey: string): void {
  const index = members.value.findIndex((member) => member.tempKey === tempKey)
  members.value = removeMemberDraft(members.value, tempKey)
  if (editingKey.value !== tempKey) return
  editingKey.value = members.value[Math.min(index, members.value.length - 1)]?.tempKey ?? ''
}

function move(tempKey: string, direction: MoveDirection): void {
  members.value = moveMemberDraft(members.value, tempKey, direction)
}

async function submit(): Promise<void> {
  if (creating.value) return

  const groupName = name.value.trim()
  if (!groupName) {
    message.warning('给群组起个名字')
    return
  }

  const validModelRowIds = new Set(
    collab.toolModels.flatMap(({ models }) => models.map((model) => model.id))
  )
  const memberError = validateMemberDrafts(members.value, validModelRowIds)
  if (memberError) {
    message.warning(memberError)
    return
  }

  creating.value = true
  try {
    // 每层都摊成普通对象/数组，避免把 Vue Proxy 交给 structured clone。
    const created = await collab.createGroup({
      name: groupName,
      members: toGroupMemberDrafts(members.value)
    })
    open.value = false
    emit('created', created)
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <a-modal
    v-model:open="open"
    title="新建群组"
    :confirm-loading="creating"
    :width="900"
    centered
    ok-text="建群"
    @ok="submit"
  >
    <div class="create-body">
      <a-form layout="vertical">
        <a-form-item label="群组名称" html-for="group-name" required>
          <a-input
            id="group-name"
            v-model:value="name"
            aria-label="群组名称"
            data-testid="group-name"
            size="large"
            placeholder="如 官网改版专项 / 管理后台需求评审"
            @press-enter="submit"
          />
        </a-form-item>
      </a-form>

      <div class="template-head">
        <span class="section-title">快捷模板</span>
        <span class="section-hint" :style="{ color: token.colorTextTertiary }">
          模板只复制职责与人设，模型和技能由你配置
        </span>
      </div>
      <div class="template-row">
        <a-button
          v-for="role in collab.roles"
          :key="role.id"
          :data-testid="`add-template-${role.id}`"
          size="small"
          @click="addTemplate(role)"
        >
          <span class="template-dot" :style="{ background: role.color }" />
          {{ role.name }}
        </a-button>
        <a-button data-testid="add-blank-member" size="small" type="dashed" @click="addBlank">
          <template #icon><PlusOutlined /></template>
          空白成员
        </a-button>
      </div>

      <div class="member-layout">
        <section class="member-column">
          <div class="section-title">群组成员 · {{ members.length }}</div>
          <GroupMemberList
            :members="members"
            :active-key="editingKey"
            @edit="edit"
            @remove="remove"
            @move="move"
          />
        </section>

        <section class="editor-column">
          <GroupMemberEditor
            v-if="editingMember"
            :model-value="editingMember"
            :model-groups="collab.toolModels"
            :skills="skills"
            @update:model-value="updateMember"
          />
          <div
            v-else
            class="editor-placeholder"
            :style="{ color: token.colorTextTertiary, borderColor: token.colorBorderSecondary }"
          >
            添加或选择一位成员后，在这里配置它
          </div>
        </section>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.create-body {
  max-height: 70vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 2px;
}

.template-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
}

.section-hint {
  font-size: 11px;
}

.template-row {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin: 8px 0 18px;
}

.template-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 5px;
  border-radius: 50%;
}

.member-layout {
  display: grid;
  grid-template-columns: minmax(260px, 0.8fr) minmax(360px, 1.2fr);
  gap: 14px;
  align-items: start;
}

.member-column,
.editor-column {
  min-width: 0;
}

.member-column > .section-title {
  display: block;
  margin-bottom: 8px;
}

.editor-placeholder {
  display: grid;
  min-height: 240px;
  place-items: center;
  border: 1px dashed;
  border-radius: 12px;
  font-size: 12px;
}

@media (max-width: 760px) {
  .member-layout {
    grid-template-columns: 1fr;
  }
}
</style>
