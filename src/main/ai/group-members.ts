import { aiText } from '../i18n'
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
  throw new Error(aiText('ai.groupMembers.couldNotGenerateAUniqueMemberId'))
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
  if (!isGroupMemberDraft(draft))
    throw new Error(aiText('ai.groupMembers.invalidDataForMember', position))
  const name = draft.name.trim()
  const persona = draft.persona.trim()

  if (!name) throw new Error(aiText('ai.groupMembers.memberMustHaveAName', position))
  if (Array.from(name).length > MAX_NAME_LENGTH) {
    throw new Error(aiText('ai.groupMembers.memberNamesCannotExceedCharacters', MAX_NAME_LENGTH))
  }
  if (INVALID_NAME.test(name)) {
    throw new Error(aiText('ai.groupMembers.memberNamesCannotContainLineBreaksOr'))
  }
  if (name === '用户' || name.toLowerCase() === 'user')
    throw new Error(aiText('ai.groupMembers.isAReservedName'))
  if (context.usedNames.has(name))
    throw new Error(aiText('ai.groupMembers.duplicateMemberName', name))
  if (!persona) throw new Error(aiText('ai.groupMembers.memberMustHaveAPersona', name))

  const selectedModel = context.modelsById.get(draft.modelRowId)
  if (!selectedModel)
    throw new Error(aiText('ai.groupMembers.theModelSelectedForDoesNotExist', name))
  if (!selectedModel.enabled)
    throw new Error(aiText('ai.groupMembers.theModelSelectedForIsDisabled', name))
  if (selectedModel.type !== 'chat')
    throw new Error(aiText('ai.groupMembers.memberMustUseAChatModel', name))
  if (!selectedModel.abilities.includes('tools')) {
    throw new Error(aiText('ai.groupMembers.theModelSelectedForDoesNotSupportTools', name))
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
  if (!Array.isArray(drafts)) throw new Error(aiText('ai.groupMembers.memberDataMustBeAnArray'))
  if (drafts.length === 0) throw new Error(aiText('ai.groupMembers.aGroupNeedsAtLeastOneMember'))

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
  if (!Array.isArray(drafts)) throw new Error(aiText('ai.groupMembers.memberDataMustBeAnArray'))
  if (drafts.length === 0) throw new Error(aiText('ai.groupMembers.aGroupNeedsAtLeastOneMember'))

  const existingIds = new Set(existing.map((member) => member.id))
  const keptIds = new Set<string>()
  for (const draft of drafts) {
    const id = (draft as { id?: unknown }).id
    if (id === undefined) continue
    if (typeof id !== 'string' || !existingIds.has(id)) {
      throw new Error(aiText('ai.groupMembers.thisMemberIdDoesNotBelongToTheGroup'))
    }
    if (keptIds.has(id)) throw new Error(aiText('ai.groupMembers.theSameMemberAppearsTwice'))
    keptIds.add(id)
  }
  const missing = existing.find((member) => !keptIds.has(member.id))
  if (missing) {
    throw new Error(aiText('ai.groupMembers.existingMemberCannotBeRemovedBecause', missing.name))
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
  if (!selectedModel)
    throw new Error(aiText('ai.groupMembers.theModelSelectedForDoesNotExist', member.name))
  if (!selectedModel.enabled)
    throw new Error(aiText('ai.groupMembers.theModelSelectedForIsDisabled', member.name))
  if (selectedModel.type !== 'chat')
    throw new Error(aiText('ai.groupMembers.theModelSelectedForIsNotAChatModel', member.name))
  if (!selectedModel.abilities.includes('tools')) {
    throw new Error(aiText('ai.groupMembers.theModelSelectedForDoesNotSupportTools', member.name))
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
