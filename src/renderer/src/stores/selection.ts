import type { ProjectSettings } from '@shared/types'

/**
 * 工作台选择的恢复规则。
 *
 * 抽成纯函数是因为这里有两个很容易写错、且错了要到"重启之后"才看得见的
 * 判断:`null` 与 `[]` 的区别,以及存档里的 id 可能已经指向被删掉的东西。
 * 组件里塞不下测试,这里可以。
 */

/** 有 id 和启用开关的东西——技能和 MCP 服务在这件事上形状一样 */
export interface Toggleable {
  id: string
  enabled: boolean
}

/**
 * 把存档里的 id 集合与当前真实存在的条目对齐。
 *
 * - `null`(这个项目没选过)→ 用全局启用的那些当默认
 * - 有值(**包括空数组**)→ 保留用户的选择,只剔掉已经不存在的 id
 *
 * 空数组必须原样返回:那是用户明确"一个都不要"。要是当成"没选过"去补
 * 默认值,用户取消勾选的操作一重启就被撤销了。
 */
export function reconcileIds(saved: string[] | null, available: Toggleable[]): string[] {
  if (saved == null) return available.filter((x) => x.enabled).map((x) => x.id)
  const alive = new Set(available.map((x) => x.id))
  return saved.filter((id) => alive.has(id))
}

export interface ModelChoice {
  providerId: string
  modelId: string
}

/** 存档里两个字段都齐了才算数——只存了一半的记录不如当没选过 */
export function restoreModelChoice(settings: ProjectSettings | null): ModelChoice | null {
  if (!settings?.providerId || !settings.modelId) return null
  return { providerId: settings.providerId, modelId: settings.modelId }
}

/**
 * 存档里的模型现在还在不在。
 *
 * 供应商可能被删了、模型可能被停用了。不检查的话选择器会显示成一个认不出
 * 的空值,而且发出去必然报错——存档必须被当作**可能过期的**来对待。
 */
export function isChoiceAlive(
  choice: ModelChoice | null,
  groups: { provider: { id: string }; models: { id: string }[] }[]
): boolean {
  if (!choice) return false
  return groups.some(
    (g) => g.provider.id === choice.providerId && g.models.some((m) => m.id === choice.modelId)
  )
}
