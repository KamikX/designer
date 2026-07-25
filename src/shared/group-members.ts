import type { GroupMember, GroupRoleMeta, SessionSettings } from './types'

export type NormalizedGroupMember =
  { kind: 'configured'; member: GroupMember } | { kind: 'legacy'; role: GroupRoleMeta }

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isGroupMember(value: unknown): value is GroupMember {
  if (value == null || typeof value !== 'object') return false
  const member = value as Record<string, unknown>
  return (
    isString(member.id) &&
    isString(member.name) &&
    isString(member.color) &&
    isString(member.duty) &&
    isString(member.deliverable) &&
    isString(member.persona) &&
    isString(member.modelRowId) &&
    Array.isArray(member.skillIds) &&
    member.skillIds.every(isString)
  )
}

export function isLegacyGroupMembers(members: SessionSettings['members']): members is string[] {
  return Array.isArray(members) && members.every(isString)
}

export function isConfiguredGroupMembers(
  members: SessionSettings['members']
): members is GroupMember[] {
  return Array.isArray(members) && members.length > 0 && members.every(isGroupMember)
}

/**
 * 把 settings 中的新旧成员形态转成展示联合类型。
 *
 * 旧角色元数据由调用方传入，使该共享模块不依赖只存在于主进程的内置人设。
 * 损坏或混合形态的数据不猜测、不补造必填字段。
 */
export function normalizeGroupMembers(
  members: SessionSettings['members'],
  legacyRoles: readonly GroupRoleMeta[]
): NormalizedGroupMember[] {
  if (isLegacyGroupMembers(members)) {
    const rolesById = new Map(legacyRoles.map((role) => [role.id, role]))
    return members.flatMap((id) => {
      const role = rolesById.get(id)
      return role ? [{ kind: 'legacy' as const, role }] : []
    })
  }

  if (isConfiguredGroupMembers(members)) {
    return members.map((member) => ({ kind: 'configured', member }))
  }

  return []
}
