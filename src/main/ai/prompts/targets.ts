import { promptText } from './i18n'
import type { PromptLanguage } from './i18n'
import type { DesignTarget } from '../../../shared/types'
import type { TargetTemplate } from '../../skills/targets'

/**
 * 端契约:项目勾选了哪些端,这里就注入哪几条。
 *
 * 与端模板(resources/skills/target-*)的分工遵守"一条规则只有一个家":
 * 具体的路由表、硬规则、自查项都在模板里;这里只放三样模板管不到的东西——
 * 每个端的**角色定位**(一句话切人格)、跨端共用的**提问纪律**、多端项目的
 * **交付物结构**。规则本体不在这里重复,重复的两份迟早互相矛盾。
 *
 * 位置:项目创建时勾定、之后不变,所以排在 system prompt 的项目稳定区,
 * 不破坏前缀缓存。
 */

export const TARGET_LABELS = targetLabels('zh-CN')

/**
 * 一句话切人格。借 open-design 的做法:同一个模型,先说清"此刻你是谁",
 * 产出的姿态就跟着变——落地页需要的是品牌感,中后台需要的是清晰的运营效率。
 */
function targetLabels(lang: PromptLanguage): Record<DesignTarget, string> {
  return {
    landing: promptText(lang, 'targets.labels.landing'),
    web: promptText(lang, 'targets.labels.web'),
    mobile: promptText(lang, 'targets.labels.mobile'),
    admin: promptText(lang, 'targets.labels.admin')
  }
}

function targetRoles(lang: PromptLanguage): Record<DesignTarget, string> {
  return {
    landing: promptText(lang, 'targets.roles.landing'),
    web: promptText(lang, 'targets.roles.web'),
    mobile: promptText(lang, 'targets.roles.mobile'),
    admin: promptText(lang, 'targets.roles.admin')
  }
}

export function targetContractPrompt(
  targets: DesignTarget[],
  lang: PromptLanguage = 'zh-CN'
): string {
  if (targets.length === 0) return ''

  const roles = targets.map((t) => `- ${targetRoles(lang)[t]}`).join('\n')
  const multi = targets.length > 1 ? promptText(lang, 'targets.multiTarget') : ''

  return promptText(lang, 'targets.contract', {
    targets: targets.map((t) => targetLabels(lang)[t]).join(lang === 'zh-CN' ? '、' : ', '),
    roles: roles,
    multi: multi
  })
}

/**
 * 活动目标路由:多端项目每轮只为**活动端**注入完整模板。
 *
 * 完整端模板动辄几千 token,三个端全量注入等于每一步都白付两份。判定按
 * 确定性递减:用户本轮点名 > 文件路径唯一指向 > 项目只有一个端;都定不了
 * 就一个完整模板都不注入,全部走一句话兼容契约——宁可让模型先声明切换,
 * 也不为"可能用得上"付三倍稳定区。
 */
const TARGET_KEYWORDS: Record<DesignTarget, RegExp> = {
  admin: /中后台|后台|admin|管理端|运营端/i,
  landing: /落地页|landing|官网首页|营销页/i,
  mobile: /移动端|手机|mobile|app\b|真机/i,
  web: /web 应用|web应用|pc 端|pc端|桌面端/i
}

/** 文件路径 → 端的启发:多端交付结构约定每端一个入口/目录 */
const TARGET_PATH_HINTS: Record<DesignTarget, RegExp> = {
  admin: /(^|\/)admin[./]/,
  landing: /(^|\/)landing[./]/,
  mobile: /(^|\/)mobile[./]/,
  web: /(^|\/)web[./]/
}

export interface TargetRouteInput {
  targets: DesignTarget[]
  userText: string
  currentFiles: { path: string }[]
}

export interface TargetRoute {
  /** 注入完整模板的端 */
  active: DesignTarget[]
  /** 只留一句兼容契约的端 */
  compat: DesignTarget[]
}

export function routeActiveTargets(input: TargetRouteInput): TargetRoute {
  const { targets } = input
  if (targets.length <= 1) return { active: [...targets], compat: [] }

  // 1. 用户本轮明确点名
  const named = targets.filter((t) => TARGET_KEYWORDS[t].test(input.userText))
  if (named.length >= 1) {
    return { active: named, compat: targets.filter((t) => !named.includes(t)) }
  }

  // 2. 当前文件路径能唯一确定
  const byPath = targets.filter((t) =>
    input.currentFiles.some((f) => TARGET_PATH_HINTS[t].test(f.path))
  )
  if (byPath.length === 1) {
    return { active: byPath, compat: targets.filter((t) => t !== byPath[0]) }
  }

  // 3. 定不下来:全部只给兼容契约
  return { active: [], compat: [...targets] }
}

/** 非活动端的一句话兼容说明:告诉模型它们存在,但本轮没有模板正文 */
export function renderCompatNote(compat: DesignTarget[], lang: PromptLanguage = 'zh-CN'): string {
  if (compat.length === 0) return ''
  const names = compat.map((t) => targetLabels(lang)[t]).join(lang === 'zh-CN' ? '、' : ', ')
  return promptText(lang, 'targets.compatibility', { names: names })
}

/**
 * 端模板正文,组装期直接注入。
 *
 * 不走 activate_skill 有两个原因:一,路由已经由勾选决定,不该再赌模型
 * "想起来"去加载;二,markers 模式(无工具的长尾模型)根本没有 activate_skill,
 * 组装期注入是它拿到端规范的唯一途径。
 */
export function renderTargetTemplates(templates: TargetTemplate[]): string {
  if (templates.length === 0) return ''
  return templates.map((t) => t.body).join('\n\n---\n\n')
}
