<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { App, theme } from 'antdv-next'
import { PlusOutlined } from '@antdv-next/icons'
import { useCollabStore } from '@renderer/stores/collab'
import { useProviderStore } from '@renderer/stores/provider'
import GroupMemberEditor from './GroupMemberEditor.vue'
import GroupMemberList from './GroupMemberList.vue'
import {
  createBlankMemberDraft,
  createMemberDraftFromTemplate,
  memberToDraft,
  moveMemberDraft,
  removeMemberDraft,
  toGroupMemberDrafts,
  toGroupMemberUpdates,
  validateMemberDrafts
} from '../member-drafts'
import { normalizeGroupMembers } from '@shared/group-members'
import type { Conversation, GroupMemberTemplate, InstalledSkill } from '@shared/types'
import type { MemberDraft, MoveDirection } from '../member-drafts'

/**
 * 群组表单弹窗,创建 / 编辑双模式:传了 group 就是编辑。
 * 编辑模式下已有成员只能改配置不能删除——历史消息的 author 引用着成员
 * ULID,删人会让 TA 的发言变成查无此人;新加的成员保存前仍可自由移除。
 */
const props = defineProps<{ group?: Conversation | null }>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ created: [group: Conversation]; saved: [group: Conversation] }>()

const isEdit = computed(() => Boolean(props.group))

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
    if (props.group) {
      name.value = props.group.title
      members.value = normalizeGroupMembers(props.group.settings?.members).map((member) =>
        memberToDraft(member)
      )
      editingKey.value = members.value[0]?.tempKey ?? ''
    } else {
      name.value = ''
      members.value = []
      editingKey.value = ''
    }
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
    message.error(uiMessage(error instanceof Error ? error.message : String(error)))
  }
}

function addTemplate(template: GroupMemberTemplate): void {
  const draft = createMemberDraftFromTemplate({
    ...template,
    name: uiMessage(template.name),
    duty: uiMessage(template.duty),
    deliverable: uiMessage(template.deliverable),
    persona: uiMessage(template.persona)
  })
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
    message.warning(t('messages.enterAGroupName'))
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
    if (props.group) {
      const saved = await collab.updateGroup({
        id: props.group.id,
        name: groupName,
        members: toGroupMemberUpdates(members.value)
      })
      open.value = false
      emit('saved', saved)
    } else {
      const created = await collab.createGroup({
        name: groupName,
        members: toGroupMemberDrafts(members.value)
      })
      open.value = false
      emit('created', created)
    }
  } catch (error) {
    message.error(uiMessage(error instanceof Error ? error.message : String(error)))
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <a-modal
    v-model:open="open"
    :title="isEdit ? t('common.groupSettings') : t('common.newGroup')"
    :confirm-loading="creating"
    :width="900"
    centered
    :ok-text="isEdit ? t('common.save') : t('common.createGroup')"
    @ok="submit"
  >
    <div class="create-body">
      <a-form layout="vertical">
        <a-form-item :label="t('common.groupName')" html-for="group-name" required>
          <a-input
            id="group-name"
            v-model:value="name"
            :aria-label="t('common.groupName')"
            data-testid="group-name"
            size="large"
            :placeholder="t('messages.eGWebsiteRedesignAdminRequirementsReview')"
            @press-enter="submit"
          />
        </a-form-item>
      </a-form>

      <div class="template-head">
        <span class="section-title">{{ t('common.quickTemplates') }}</span>
        <span class="section-hint" :style="{ color: token.colorTextTertiary }">
          {{ t('messages.templatesCopyResponsibilitiesAndPersonasConfigure') }}
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
          {{ uiMessage(role.name) }}
        </a-button>
        <a-button data-testid="add-blank-member" size="small" type="dashed" @click="addBlank">
          <template #icon><PlusOutlined /></template>
          {{ t('common.blankMember') }}
        </a-button>
      </div>

      <div class="member-layout">
        <section class="member-column">
          <div class="section-title">{{ t('common.groupMembers') }} {{ members.length }}</div>
          <div v-if="isEdit" class="section-hint" :style="{ color: token.colorTextTertiary }">
            {{ t('messages.existingMembersCanBeEditedBut') }}
          </div>
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
            {{ t('messages.addOrSelectAMemberToConfigureItHere') }}
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

.member-column > .section-hint {
  margin: -4px 0 8px;
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
