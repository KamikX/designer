import type { GroupMember, GroupMemberDraft, InstalledSkill, Model } from '../../shared/types'

export interface CreateGroupMembersDependencies {
  models: readonly Model[]
  skills: readonly InstalledSkill[]
  createId: () => string
}

export type ResolvedGroupAgent = Omit<GroupMember, 'modelRowId'> & {
  model: Model
}

const INVALID_NAME = /[@[\]()\r\n\u2028\u2029]/
const MAX_NAME_LENGTH = 24
const MAX_ID_ATTEMPTS = 100

function isGroupMemberDraft(value: unknown): value is GroupMemberDraft {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const draft = value as Record<string, unknown>
  return (
    typeof draft.name === 'string' &&
    typeof draft.color === 'string' &&
    typeof draft.duty === 'string' &&
    typeof draft.deliverable === 'string' &&
    typeof draft.persona === 'string' &&
    typeof draft.modelRowId === 'string' &&
    Array.isArray(draft.skillIds) &&
    draft.skillIds.every((skillId) => typeof skillId === 'string')
  )
}

function uniqueMemberId(createId: () => string, usedIds: Set<string>): string {
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const id = createId()
    if (id && !usedIds.has(id)) {
      usedIds.add(id)
      return id
    }
  }
  throw new Error('无法生成唯一成员 ID')
}

export function createGroupMembers(
  drafts: readonly GroupMemberDraft[],
  dependencies: CreateGroupMembersDependencies
): GroupMember[] {
  if (!Array.isArray(drafts)) throw new Error('成员数据必须是数组')
  if (drafts.length === 0) throw new Error('群组至少需要一个成员')

  const modelsById = new Map(dependencies.models.map((model) => [model.id, model]))
  // 所有已安装技能(含 builtin 设计技能)都可被显式勾选;群组场景没有自动启用
  const allowedSkills = new Set(dependencies.skills.map((skill) => skill.name))
  const usedNames = new Set<string>()
  const usedIds = new Set<string>()

  return drafts.map((draft, index) => {
    const position = index + 1
    if (!isGroupMemberDraft(draft)) throw new Error(`第 ${position} 位成员数据格式错误`)
    const name = draft.name.trim()
    const persona = draft.persona.trim()

    if (!name) throw new Error(`第 ${position} 位成员名称不能为空`)
    if (Array.from(name).length > MAX_NAME_LENGTH) {
      throw new Error(`成员名称不能超过 ${MAX_NAME_LENGTH} 个字符`)
    }
    if (INVALID_NAME.test(name)) {
      throw new Error('成员名称不能包含换行或 @[]()')
    }
    if (name === '用户') throw new Error('“用户”是保留名称')
    if (usedNames.has(name)) throw new Error(`成员名称重复：${name}`)
    if (!persona) throw new Error(`成员“${name}”的人设不能为空`)

    const selectedModel = modelsById.get(draft.modelRowId)
    if (!selectedModel) throw new Error(`成员“${name}”选择的模型不存在`)
    if (!selectedModel.enabled) throw new Error(`成员“${name}”选择的模型已停用`)
    if (selectedModel.type !== 'chat') throw new Error(`成员“${name}”必须选择对话模型`)
    if (!selectedModel.abilities.includes('tools')) {
      throw new Error(`成员“${name}”选择的模型不支持 tools`)
    }

    usedNames.add(name)
    const skillIds = [
      ...new Set(
        (Array.isArray(draft.skillIds) ? draft.skillIds : []).filter((skillId) =>
          allowedSkills.has(skillId)
        )
      )
    ]

    return {
      id: uniqueMemberId(dependencies.createId, usedIds),
      name,
      color: draft.color,
      duty: draft.duty,
      deliverable: draft.deliverable,
      persona,
      modelRowId: draft.modelRowId,
      skillIds
    }
  })
}

export function resolveGroupAgent(
  member: GroupMember,
  getModel: (modelRowId: string) => Model | null
): ResolvedGroupAgent {
  const selectedModel = getModel(member.modelRowId)
  if (!selectedModel) throw new Error(`成员“${member.name}”选择的模型不存在`)
  if (!selectedModel.enabled) throw new Error(`成员“${member.name}”选择的模型已停用`)
  if (selectedModel.type !== 'chat') throw new Error(`成员“${member.name}”选择的不是对话模型`)
  if (!selectedModel.abilities.includes('tools')) {
    throw new Error(`成员“${member.name}”选择的模型不支持 tools`)
  }

  return {
    id: member.id,
    name: member.name,
    color: member.color,
    duty: member.duty,
    deliverable: member.deliverable,
    persona: member.persona,
    model: selectedModel,
    skillIds: [...member.skillIds]
  }
}
