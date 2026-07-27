import { describe, expect, it } from 'vitest'
import type { GroupMember, Message } from './types'
import { deliverableProgress, groupDeliverables, stripHandoff } from './group-deliverables'

/**
 * 清单错了不会报错,只会让用户拿到一份"看起来齐了其实不是"的交付。
 * 重点钉:返工版本覆盖旧版、汇合棒不占位、只列参与者。
 */

const PM = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const ARCH = '01ARZ3NDEKTSV4RRFFQ69G5FAW'
const QA = '01ARZ3NDEKTSV4RRFFQ69G5FAX'

function member(id: string, name: string, deliverable: string): GroupMember {
  return {
    id,
    name,
    color: '#000',
    duty: '职责',
    deliverable,
    persona: '人设',
    modelRowId: 'model-1',
    skillIds: []
  }
}

const MEMBERS = [
  member(PM, '产品经理', '需求文档'),
  member(ARCH, '架构师', '架构设计文档'),
  member(QA, '测试工程师', '测试用例文档')
]

let seq = 0
function say(author: string, text: string, status: Message['status'] = 'complete'): Message {
  seq++
  return {
    id: `m${seq}`,
    conversationId: 'g1',
    role: author === 'user' ? 'user' : 'assistant',
    parts: [{ type: 'text', text }],
    status,
    usage: null,
    providerSlug: null,
    modelId: null,
    artifactId: null,
    author,
    createdAt: `2026-07-26T00:00:${String(seq).padStart(2, '0')}.000Z`
  }
}

describe('groupDeliverables', () => {
  it('按首次发言排序,只列参与过的成员', () => {
    const entries = groupDeliverables(
      [say('user', '开始'), say(ARCH, '# 架构设计文档'), say(PM, '# 需求文档')],
      MEMBERS
    )
    expect(entries.map((e) => e.memberName)).toEqual(['架构师', '产品经理'])
    // 没参与的测试工程师不该占一行:八人群里跑了三个,摆八条会让人以为另外五份也该有
    expect(entries.some((e) => e.memberId === QA)).toBe(false)
  })

  it('返工版本覆盖旧版:latest wins,用户不用自己找哪条算数', () => {
    const entries = groupDeliverables(
      [say(PM, '# 需求文档 v1'), say(ARCH, '# 架构设计文档'), say(PM, '# 需求文档 v2')],
      MEMBERS
    )
    const pm = entries.find((e) => e.memberId === PM)!
    expect(pm.title).toBe('需求文档 v2')
    expect(pm.status).toBe('delivered')
  })

  it('汇合棒(二级标题)不占交付物的位置', () => {
    const entries = groupDeliverables(
      [say(PM, '# 需求文档'), say(PM, '## 汇总\n\n甲乙两份没有冲突')],
      MEMBERS
    )
    // 最新一条是汇总,但交付物仍然是那份一级标题的文档
    expect(entries[0].title).toBe('需求文档')
  })

  it('发过言但没交出文档的记 pending(报错、中止、只发了汇总)', () => {
    const entries = groupDeliverables([say(PM, '我先看看资料')], MEMBERS)
    expect(entries[0]).toMatchObject({ status: 'pending', title: '', messageId: '' })
  })

  it('流式中/出错的半条不算交付', () => {
    const entries = groupDeliverables([say(PM, '# 需求文档', 'error')], MEMBERS)
    expect(entries[0].status).toBe('pending')
  })

  it('正文里出现的一级标题不算:必须是首行,否则引用别人的标题就成了自己的交付', () => {
    const entries = groupDeliverables([say(PM, '参考如下:\n\n# 架构设计文档\n\n……')], MEMBERS)
    expect(entries[0].status).toBe('pending')
  })

  it('进度用于徽标与收口判断', () => {
    const entries = groupDeliverables([say(PM, '# 需求文档'), say(ARCH, '还在看')], MEMBERS)
    expect(deliverableProgress(entries)).toEqual({ delivered: 1, total: 2 })
  })
})

describe('stripHandoff', () => {
  it('剥掉末尾的交接行:那是编排的内部信号,不该进交付物', () => {
    expect(stripHandoff('# 需求文档\n\n正文\n\n@架构师 出领域模型')).toBe('# 需求文档\n\n正文')
  })

  it('连续几行交接一起剥', () => {
    expect(stripHandoff('正文\n@测试工程师 补用例\n@文档工程师 同步文档\n')).toBe('正文')
  })

  it('正文中间的 @ 是引用,不能动', () => {
    const text = '# 文档\n\n这块按 @架构师 的方案做\n\n结尾'
    expect(stripHandoff(text)).toBe(text)
  })
})
