import type {
  GroupMember,
  GroupMemberDraft,
  GroupMemberUpdate,
  InstalledSkill,
  Model
} from '../../shared/types'

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

interface DraftContext {
  modelsById: Map<string, Model>
  allowedSkills: Set<string>
  usedNames: Set<string>
}

function buildDraftContext(dependencies: CreateGroupMembersDependencies): DraftContext {
  return {
    modelsById: new Map(dependencies.models.map((model) => [model.id, model])),
    // 所有已安装技能(含 builtin 设计技能)都可被显式勾选;群组场景没有自动启用
    allowedSkills: new Set(dependencies.skills.map((skill) => skill.name)),
    usedNames: new Set<string>()
  }
}

/** 单个成员草稿的校验与归一。建群与编辑共用同一套规则,不许出现两份口径 */
function normalizeDraft(
  draft: GroupMemberDraft,
  position: number,
  context: DraftContext
): Omit<GroupMember, 'id'> {
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
  if (context.usedNames.has(name)) throw new Error(`成员名称重复：${name}`)
  if (!persona) throw new Error(`成员“${name}”的人设不能为空`)

  const selectedModel = context.modelsById.get(draft.modelRowId)
  if (!selectedModel) throw new Error(`成员“${name}”选择的模型不存在`)
  if (!selectedModel.enabled) throw new Error(`成员“${name}”选择的模型已停用`)
  if (selectedModel.type !== 'chat') throw new Error(`成员“${name}”必须选择对话模型`)
  if (!selectedModel.abilities.includes('tools')) {
    throw new Error(`成员“${name}”选择的模型不支持 tools`)
  }

  context.usedNames.add(name)
  const skillIds = [
    ...new Set(
      (Array.isArray(draft.skillIds) ? draft.skillIds : []).filter((skillId) =>
        context.allowedSkills.has(skillId)
      )
    )
  ]

  return {
    name,
    color: draft.color,
    duty: draft.duty,
    deliverable: draft.deliverable,
    persona,
    modelRowId: draft.modelRowId,
    skillIds
  }
}

export function createGroupMembers(
  drafts: readonly GroupMemberDraft[],
  dependencies: CreateGroupMembersDependencies
): GroupMember[] {
  if (!Array.isArray(drafts)) throw new Error('成员数据必须是数组')
  if (drafts.length === 0) throw new Error('群组至少需要一个成员')

  const context = buildDraftContext(dependencies)
  const usedIds = new Set<string>()

  return drafts.map((draft, index) => ({
    id: uniqueMemberId(dependencies.createId, usedIds),
    ...normalizeDraft(draft, index + 1, context)
  }))
}

/**
 * 编辑群组成员。规则与建群一致,外加身份约束:
 *
 * - 带 id 的草稿必须对应本群已有成员——id 是渲染层传来的不可信输入,
 *   伪造别群成员的 ULID 不能混进来;
 * - 已有成员一个都不能少:消息表的 author 存的就是成员 ULID,删人会让
 *   TA 的历史发言、前情纪要里的引用全部悬空。想踢人是将来软删除的事;
 * - 不带 id 的是新成员,发新 ULID,与现有 id 不冲突。
 */
export function updateGroupMembers(
  existing: readonly GroupMember[],
  drafts: readonly GroupMemberUpdate[],
  dependencies: CreateGroupMembersDependencies
): GroupMember[] {
  if (!Array.isArray(drafts)) throw new Error('成员数据必须是数组')
  if (drafts.length === 0) throw new Error('群组至少需要一个成员')

  const existingIds = new Set(existing.map((member) => member.id))
  const keptIds = new Set<string>()
  for (const draft of drafts) {
    const id = (draft as { id?: unknown }).id
    if (id === undefined) continue
    if (typeof id !== 'string' || !existingIds.has(id)) {
      throw new Error('成员 ID 不属于这个群组')
    }
    if (keptIds.has(id)) throw new Error('同一位成员出现了两次')
    keptIds.add(id)
  }
  const missing = existing.find((member) => !keptIds.has(member.id))
  if (missing) {
    throw new Error(`已有成员“${missing.name}”不能被移除:历史消息还引用着 TA`)
  }

  const context = buildDraftContext(dependencies)
  const usedIds = new Set(existingIds)

  return drafts.map((draft, index) => ({
    id: draft.id ?? uniqueMemberId(dependencies.createId, usedIds),
    ...normalizeDraft(draft, index + 1, context)
  }))
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
