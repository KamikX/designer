import type { AXNode } from './session'

/**
 * 无障碍树 → 给模型看的紧凑文本快照。
 *
 * ## 为什么是无障碍树,不是 DOM,也不是截图
 *
 * 有实测数据(arXiv 2508.04412,52 个真实网页任务):
 *
 * | 表示方式 | token | 成功率 |
 * | --- | --- | --- |
 * | 原始 DOM | 8100 | 38% |
 * | 截图 + 编号框 | 3750 | 65% |
 * | **同上但去掉图片,只留编号文本** | — | **63%** |
 *
 * 两个结论决定了这里的写法:**原始 DOM 是有害的**(比截图还差),以及
 * **像素几乎没在起作用**——去掉图片只掉 2 个点,干活的是那些编号文本。
 * 而视觉 token 是文本的 3-5 倍。
 *
 * ## 为什么保留层级
 *
 * 同一篇论文里,保留结构的下采样(73%)明显好过展平成一列元素。所以这里按
 * 树深缩进,而不是输出一个扁平的可点击元素列表——"这个按钮在哪个区域里"
 * 本身就是信息。
 */

/** 可以交互的角色。给了 uid 的才是模型能点/能填的 */
const ACTIONABLE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'treeitem',
  'listbox'
])

/**
 * 只提供结构、不可交互的角色。
 *
 * 保留它们是为了让模型知道"这个按钮属于哪一块",而不是面对一堆无处安放的
 * 控件。但它们不发 uid——发了模型会去点标题。
 */
const STRUCTURAL = new Set([
  'heading',
  'navigation',
  'main',
  'banner',
  'contentinfo',
  'complementary',
  'form',
  'search',
  'region',
  'article',
  'dialog',
  'alertdialog',
  'table',
  'list',
  'tablist'
])

/** 名字太长会把快照撑爆,而超出的部分对"点哪个"几乎没有帮助 */
const MAX_NAME = 80
/** 整份快照的行数上限。超了就截断并明说,不要假装这就是全部 */
const MAX_LINES = 200

export interface Snapshot {
  url: string
  title: string
  /** 给模型看的文本 */
  text: string
  /** uid → backendNodeId,动作时用 */
  refs: Map<string, number>
  truncated: boolean
}

export function buildSnapshot(nodes: AXNode[], page: { url: string; title: string }): Snapshot {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]))
  const refs = new Map<string, number>()
  const lines: string[] = []
  let counter = 0
  let truncated = false

  // AX 树的根就是数组第一个;没有节点说明页面还没渲染出来
  const root = nodes[0]

  const walk = (node: AXNode, depth: number): void => {
    if (lines.length >= MAX_LINES) {
      truncated = true
      return
    }

    const role = node.role?.value ?? ''
    const name = clip(node.name?.value ?? '')
    const actionable = ACTIONABLE.has(role) && node.backendDOMNodeId !== undefined
    const structural = STRUCTURAL.has(role)

    // 忽略节点(aria-hidden、display:none 等)整棵子树都跳过——那是用户
    // 看不见的东西,让模型去点它只会白跑一步
    if (node.ignored) return

    let emitted = false
    if (actionable) {
      counter++
      const uid = `e${counter}`
      refs.set(uid, node.backendDOMNodeId!)
      lines.push(`${'  '.repeat(depth)}[${uid}] ${role}${name ? ` "${name}"` : ''}${state(node)}`)
      emitted = true
    } else if (structural && name) {
      lines.push(`${'  '.repeat(depth)}${role} "${name}"`)
      emitted = true
    }

    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId)
      if (child) walk(child, emitted ? depth + 1 : depth)
    }
  }

  if (root) walk(root, 0)

  const body = lines.join('\n')
  const tail = truncated ? `\n…(还有更多元素未列出,可以滚动或缩小范围后重新取快照)` : ''

  return {
    url: page.url,
    title: page.title,
    text: `# ${page.title}\n${page.url}\n\n${body || '(页面上没有可交互元素)'}${tail}`,
    refs,
    truncated
  }
}

/** 已选中 / 已展开 / 禁用这些状态直接影响该不该点它,值得占几个字符 */
function state(node: AXNode): string {
  const flags: string[] = []
  for (const prop of node.properties ?? []) {
    const value = prop.value?.value
    if (prop.name === 'checked' && value && value !== 'false') flags.push('已选中')
    if (prop.name === 'selected' && value === true) flags.push('已选中')
    if (prop.name === 'expanded') flags.push(value === true ? '已展开' : '已折叠')
    if (prop.name === 'disabled' && value === true) flags.push('禁用')
    if (prop.name === 'required' && value === true) flags.push('必填')
  }
  const current = node.value?.value
  if (current) flags.push(`当前值:${clip(String(current), 40)}`)
  return flags.length ? ` (${flags.join(', ')})` : ''
}

function clip(text: string, max = MAX_NAME): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
