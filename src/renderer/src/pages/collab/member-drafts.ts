import { t } from '@renderer/i18n'
import type {
  GroupMember,
  GroupMemberDraft,
  GroupMemberTemplate,
  GroupMemberUpdate
} from '@shared/types'

export interface MemberDraft extends GroupMemberDraft {
  /** 仅用于 Vue 列表和编辑态定位，绝不跨 IPC。 */
  tempKey: string
  /**
   * 编辑已有群组时携带的成员 ULID。有它 = 已有成员:不可删除(历史消息的
   * author 引用着这个 id),提交时原样带回;没有 = 保存前可自由增删的新成员。
   */
  persistedId?: string
}

type CreateKey = () => string
export type MoveDirection = 'up' | 'down'

const DEFAULT_MEMBER_COLOR = '#1677ff'
const INVALID_NAME_CHARACTERS = /[@[\]()\r\n\u2028\u2029]/u

function createTempKey(): string {
  return crypto.randomUUID()
}

export function createMemberDraftFromTemplate(
  template: GroupMemberTemplate,
  createKey: CreateKey = createTempKey
): MemberDraft {
  return {
    tempKey: createKey(),
    name: template.name,
    color: template.color,
    duty: template.duty,
    deliverable: template.deliverable,
    persona: template.persona,
    modelRowId: '',
    // 模板可以带预勾选技能(如产品经理的内置项目管理技能),用户可增删
    skillIds: [...(template.skillIds ?? [])]
  }
}

export function createBlankMemberDraft(createKey: CreateKey = createTempKey): MemberDraft {
  return {
    tempKey: createKey(),
    name: '',
    color: DEFAULT_MEMBER_COLOR,
    duty: '',
    deliverable: '',
    persona: '',
    modelRowId: '',
    skillIds: []
  }
}

/** 编辑已有群组时,把落库成员还原成可编辑草稿 */
export function memberToDraft(
  member: GroupMember,
  createKey: CreateKey = createTempKey
): MemberDraft {
  return {
    tempKey: createKey(),
    persistedId: member.id,
    name: member.name,
    color: member.color,
    duty: member.duty,
    deliverable: member.deliverable,
    persona: member.persona,
    modelRowId: member.modelRowId,
    skillIds: [...member.skillIds]
  }
}

export function removeMemberDraft(members: readonly MemberDraft[], tempKey: string): MemberDraft[] {
  // 已有成员不许删:历史消息的 author 引用着 TA 的 ULID
  return members.filter((member) => member.tempKey !== tempKey || member.persistedId)
}

export function moveMemberDraft(
  members: readonly MemberDraft[],
  tempKey: string,
  direction: MoveDirection
): MemberDraft[] {
  const index = members.findIndex((member) => member.tempKey === tempKey)
  const target = direction === 'up' ? index - 1 : index + 1
  if (index < 0 || target < 0 || target >= members.length) return [...members]

  const next = [...members]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export function validateMemberDrafts(
  members: readonly MemberDraft[],
  validModelRowIds: ReadonlySet<string>
): string | null {
  if (members.length === 0) return t('messages.addAtLeastOneMember')

  const names = new Set<string>()
  for (const member of members) {
    const name = member.name.trim()
    const length = [...name].length
    if (length < 1 || length > 24) return t('messages.memberNamesMustContain124Characters')
    if (INVALID_NAME_CHARACTERS.test(name)) {
      return t('messages.memberNamesCannotContainOrLineBreaks')
    }
    if (name === '用户' || name.toLowerCase() === 'user') return t('messages.memberNamesCannotBe')
    if (names.has(name)) return t('messages.memberNamesMustBeUnique')
    names.add(name)

    if (!member.persona.trim()) return t('messages.enterAPersonaFor', name)
    if (!validModelRowIds.has(member.modelRowId)) {
      return t('messages.selectAModelWithToolSupportFor', name)
    }
  }

  return null
}

export function toGroupMemberDrafts(members: readonly MemberDraft[]): GroupMemberDraft[] {
  return members.map(({ name, color, duty, deliverable, persona, modelRowId, skillIds }) => ({
    name: name.trim(),
    color,
    duty: duty.trim(),
    deliverable: deliverable.trim(),
    persona: persona.trim(),
    modelRowId,
    skillIds: [...skillIds]
  }))
}

/** 编辑提交:已有成员带回 ULID,新成员不带(id 由主进程生成) */
export function toGroupMemberUpdates(members: readonly MemberDraft[]): GroupMemberUpdate[] {
  return members.map((member) => ({
    ...toGroupMemberDrafts([member])[0],
    ...(member.persistedId ? { id: member.persistedId } : {})
  }))
}
