import type { ProjectSettings } from '@shared/types'

/**
 * 工作台选择的恢复规则。
 *
 * 抽成纯函数是因为这里有两个很容易写错、且错了要到"重启之后"才看得见的
 * 判断:`null` 与 `[]` 的区别,以及存档里的 id 可能已经指向被删掉的东西。
 * 组件里塞不下测试,这里可以。
 */

/**
 * 把存档里的名字集合与当前真实存在的条目对齐。
 *
 * 技能与 MCP 的身份都是**名字**(目录名 / mcp.json 的键),没有数据库 id。
 *
 * - `null`(没选过)→ 空数组。**默认零勾选**:不勾就什么都不加载,
 *   这是"手动选择"模式的立身之本,没有"按全局启用兜底"这条路
 * - 有值(包括空数组)→ 保留用户的选择,只剔掉已经不存在的名字
 */
export function reconcileNames(saved: string[] | null, available: { name: string }[]): string[] {
  if (saved == null) return []
  const alive = new Set(available.map((x) => x.name))
  return saved.filter((name) => alive.has(name))
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
