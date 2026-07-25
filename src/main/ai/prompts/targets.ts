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

export const TARGET_LABELS: Record<DesignTarget, string> = {
  landing: '落地页',
  web: 'Web 应用',
  mobile: '移动端 App',
  admin: '中后台'
}

/**
 * 一句话切人格。借 open-design 的做法:同一个模型,先说清"此刻你是谁",
 * 产出的姿态就跟着变——落地页需要的是品牌感,中后台需要的恰恰是无趣。
 */
const TARGET_ROLES: Record<DesignTarget, string> = {
  landing: '**落地页** —— 此刻你是品牌设计师:讲一个故事、推一个行动,整页只允许一个决定性的亮点。',
  web: '**Web 应用** —— 此刻你是系统设计师:hover、焦点、键盘是一等公民,第一屏就是干活的界面。',
  mobile: '**移动端 App** —— 此刻你是交互设计师:真机框呈现,一屏只做一件事,拇指够得着才算数。',
  admin: '**中后台** —— 此刻你是信息架构师:密度即功能,装饰即噪音,克制到近乎无趣才是对的。'
}

/**
 * 风格骰子:从项目 id 派生的确定性数字。
 *
 * 模板里的风格维度表要求"别每次都选同一组",但模型看不见别的项目,
 * "换一组"没有依据——它只会一次次落回自己最顺手的默认。骰子给它一个
 * 项目间不同、项目内稳定的起点(稳定是为了不破坏 prompt 前缀缓存,
 * 也为了同一项目多轮迭代风格不漂移)。用户或 brief 的明确指向永远优先。
 */
function styleDice(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return (Math.abs(h) % 5) + 1
}

export function targetContractPrompt(targets: DesignTarget[], projectId = ''): string {
  if (targets.length === 0) return ''

  const roles = targets.map((t) => `- ${TARGET_ROLES[t]}`).join('\n')
  const multi =
    targets.length > 1
      ? `

**多端交付结构**:每个端是独立交付物。html 栈每端一个入口文件(如 mobile.html、
landing.html),index.html 只做链接各端的启动页;vue3/react 栈每端一个顶层视图,
App 里做入口切换。**绝不做"同一页面里的平台切换 tab"**——那是设计工具的控件,
不是产品的一部分。一次先做透一个端,再做下一个。`
      : ''

  return `## 本项目的端

勾选的端:${targets.map((t) => TARGET_LABELS[t]).join('、')}。对应的端设计模板已注入在下方,
**不要再用 activate_skill 加载它们**。

${roles}

**动手前的纪律(所有端通用)**:

- 先按模板里的格式输出一行判读(这页给谁、做什么、什么气质),让用户在你写完
  两百行代码**之前**就能便宜地纠偏。
- 判读里的空、brief 又确实没给,才用 ask_user 问:一轮最多问一次,一次不超过
  3 题,每题给选项。用户跳过就按模板默认继续,不再问第二次。
- 用户的话命中模板「信号追问」表里的条目时,追**那个点**,不要问通用问卷。
- **风格骰子:${styleDice(projectId)}**。模板风格维度表(以及 design-seed 色板
  家族表)里几个选项都说得通时,选第 ${styleDice(projectId)} 个(数到头回绕),
  别落回你最顺手的那组。用户或 brief 有明确指向时,永远听用户的,骰子作废。${multi}`
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
