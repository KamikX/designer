import { describe, expect, it } from 'vitest'
import { buildSnapshot } from './snapshot'
import type { AXNode } from './session'

/**
 * 快照是模型看世界的唯一窗口——它看不到像素,只看到这段文本。所以这里测的
 * 不是"能不能跑",而是**信息取舍对不对**:该给编号的给了、不该点的没给编号、
 * 看不见的没混进来、层级还在。
 *
 * 这块跑在 Electron 里没法实跑,所以序列化写成了纯函数,拿真实的 CDP 节点
 * 结构喂进来测。
 */

const node = (id: string, role: string, name?: string, extra: Partial<AXNode> = {}): AXNode => ({
  nodeId: id,
  role: { value: role },
  ...(name ? { name: { value: name } } : {}),
  backendDOMNodeId: Number(id.replace(/\D/g, '')) + 1000,
  ...extra
})

const page = { url: 'https://example.com/login', title: '登录' }

describe('可交互元素', () => {
  it('给编号,并带上角色和名字', () => {
    const out = buildSnapshot(
      [node('1', 'main', '', { childIds: ['2'] }), node('2', 'button', '提交')],
      page
    )
    expect(out.text).toContain('[e1] button "提交"')
    expect(out.refs.get('e1')).toBe(1002)
  })

  it('编号能解析回 backendNodeId——点击全靠它', () => {
    const out = buildSnapshot(
      [
        node('1', 'main', '', { childIds: ['2', '3'] }),
        node('2', 'link', 'A'),
        node('3', 'textbox', 'B')
      ],
      page
    )
    expect([...out.refs.keys()]).toEqual(['e1', 'e2'])
    expect(out.refs.get('e2')).toBe(1003)
  })

  it('没有 backendNodeId 的不给编号——给了也点不了', () => {
    const out = buildSnapshot(
      [
        node('1', 'main', '', { childIds: ['2'] }),
        { nodeId: '2', role: { value: 'button' }, name: { value: '幽灵' } }
      ],
      page
    )
    expect(out.refs.size).toBe(0)
  })
})

describe('结构节点', () => {
  it('保留标题和地标,但**不给编号**', () => {
    const out = buildSnapshot(
      [node('1', 'main', '主区', { childIds: ['2'] }), node('2', 'heading', '账号登录')],
      page
    )
    expect(out.text).toContain('heading "账号登录"')
    // 给了编号模型就会去点标题,白跑一步
    expect(out.text).not.toContain('[e')
    expect(out.refs.size).toBe(0)
  })

  it('层级用缩进表达——"按钮在哪个区域里"本身就是信息', () => {
    const out = buildSnapshot(
      [node('1', 'navigation', '主导航', { childIds: ['2'] }), node('2', 'link', '首页')],
      page
    )
    const lines = out.text.split('\n').filter((l) => l.includes('link'))
    expect(lines[0]).toMatch(/^ {2}\[e1\]/)
  })

  it('没有名字的结构节点不占行,但子节点的层级不受影响', () => {
    const out = buildSnapshot(
      [node('1', 'region', '', { childIds: ['2'] }), node('2', 'button', '确定')],
      page
    )
    expect(out.text).not.toContain('region')
    // 父节点没输出,子节点就不该缩进
    expect(out.text).toContain('[e1] button "确定"')
  })
})

describe('看不见的东西不能进来', () => {
  it('ignored 节点连同整棵子树跳过', () => {
    const out = buildSnapshot(
      [
        node('1', 'main', '', { childIds: ['2'] }),
        node('2', 'region', '隐藏区', { ignored: true, childIds: ['3'] }),
        node('3', 'button', '藏起来的按钮')
      ],
      page
    )
    // 让模型去点一个 display:none 的按钮,只会白跑一步还看不出为什么
    expect(out.text).not.toContain('藏起来的按钮')
    expect(out.refs.size).toBe(0)
  })
})

describe('状态标注', () => {
  it('选中 / 展开 / 禁用直接影响该不该点它', () => {
    const out = buildSnapshot(
      [
        node('1', 'main', '', { childIds: ['2', '3', '4'] }),
        node('2', 'checkbox', '记住我', {
          properties: [{ name: 'checked', value: { value: 'true' } }]
        }),
        node('3', 'button', '更多', {
          properties: [{ name: 'expanded', value: { value: false } }]
        }),
        node('4', 'button', '提交', {
          properties: [{ name: 'disabled', value: { value: true } }]
        })
      ],
      page
    )
    expect(out.text).toContain('已选中')
    expect(out.text).toContain('已折叠')
    expect(out.text).toContain('禁用')
  })

  it('输入框的当前值要显示——模型得知道填过没有', () => {
    const out = buildSnapshot(
      [
        node('1', 'main', '', { childIds: ['2'] }),
        node('2', 'textbox', '邮箱', { value: { value: 'a@b.com' } })
      ],
      page
    )
    expect(out.text).toContain('a@b.com')
  })
})

describe('体积控制', () => {
  it('超长名字截断,不让单个元素撑爆快照', () => {
    const out = buildSnapshot(
      [node('1', 'main', '', { childIds: ['2'] }), node('2', 'link', 'x'.repeat(300))],
      page
    )
    expect(out.text).toContain('…')
    expect(out.text.split('\n').every((l) => l.length < 200)).toBe(true)
  })

  it('元素过多时截断,并**明说还有更多**', () => {
    const children = Array.from({ length: 400 }, (_, i) => String(i + 2))
    const nodes: AXNode[] = [
      node('1', 'main', '', { childIds: children }),
      ...children.map((id) => node(id, 'link', `链接 ${id}`))
    ]
    const out = buildSnapshot(nodes, page)
    expect(out.truncated).toBe(true)
    // 不说的话模型会以为这就是全部,然后断定"页面上没有那个按钮"
    expect(out.text).toContain('还有更多元素未列出')
  })
})

describe('边界', () => {
  it('空树不报错,并明确说没有可交互元素', () => {
    const out = buildSnapshot([], page)
    expect(out.text).toContain('没有可交互元素')
    expect(out.refs.size).toBe(0)
  })

  it('头部带上标题和地址,模型要知道自己在哪', () => {
    const out = buildSnapshot([node('1', 'main', '', {})], page)
    expect(out.text).toContain('登录')
    expect(out.text).toContain('https://example.com/login')
  })

  it('childIds 指向不存在的节点时不崩', () => {
    const out = buildSnapshot([node('1', 'main', '', { childIds: ['404'] })], page)
    expect(out.refs.size).toBe(0)
  })
})
