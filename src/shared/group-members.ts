import type { GroupMember } from './types'
import { isGroupMemberId } from './group-mentions'

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function isGroupMember(value: unknown): value is GroupMember {
  if (value == null || typeof value !== 'object') return false
  const member = value as Record<string, unknown>
  return (
    isString(member.id) &&
    isGroupMemberId(member.id) &&
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

export function isConfiguredGroupMembers(members: unknown): members is GroupMember[] {
  return Array.isArray(members) && members.length > 0 && members.every(isGroupMember)
}

/**
 * settings 来自 JSON，运行时仍按不可信输入处理。
 * 损坏或非对象数组不猜测、不补造成员，调用方自然得到空群。
 */
export function normalizeGroupMembers(members: unknown): GroupMember[] {
  return isConfiguredGroupMembers(members) ? members : []
}
