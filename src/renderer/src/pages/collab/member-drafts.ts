import type { GroupMemberDraft, GroupMemberTemplate } from '@shared/types'

export interface MemberDraft extends GroupMemberDraft {
  /** 仅用于 Vue 列表和编辑态定位，绝不跨 IPC。 */
  tempKey: string
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

export function removeMemberDraft(members: readonly MemberDraft[], tempKey: string): MemberDraft[] {
  return members.filter((member) => member.tempKey !== tempKey)
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
  if (members.length === 0) return '至少添加一位成员'

  const names = new Set<string>()
  for (const member of members) {
    const name = member.name.trim()
    const length = [...name].length
    if (length < 1 || length > 24) return '成员名称长度需为 1–24 个字符'
    if (INVALID_NAME_CHARACTERS.test(name)) {
      return '成员名称不能包含 @、[、]、(、) 或换行'
    }
    if (name === '用户') return '成员名称不能使用“用户”'
    if (names.has(name)) return '成员名称不能重复'
    names.add(name)

    if (!member.persona.trim()) return `请填写“${name}”的人设`
    if (!validModelRowIds.has(member.modelRowId)) {
      return `请为“${name}”选择支持工具调用的模型`
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
