import { describe, expect, it, vi } from 'vitest'
import type { Conversation, GroupMember, Message } from '../shared/types'

vi.mock('electron', () => ({ dialog: {}, shell: {} }))
vi.mock('./db/repo/conversation', () => ({ getConversation: () => null }))
vi.mock('./db/repo/message', () => ({ listMessages: () => [] }))

const { renderGroupDeliverables } = await import('./group-export')

/**
 * 导出的价值全在"干净":只收交付物、剥掉交接行、不出现 ULID。
 * 少剥一样,用户拿到的就还是那份"太乱"的东西。
 */

const PM = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const ARCH = '01ARZ3NDEKTSV4RRFFQ69G5FAW'

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

const MEMBERS = [member(PM, '产品经理', '需求文档'), member(ARCH, '架构师', '架构设计文档')]

const GROUP: Conversation = {
  id: 'g1',
  projectId: null,
  title: '记账 App',
  kind: 'group',
  settings: null,
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:00:00.000Z'
}

let seq = 0
function say(author: string, text: string): Message {
  seq++
  return {
    id: `m${seq}`,
    conversationId: 'g1',
    role: 'assistant',
    parts: [{ type: 'text', text }],
    status: 'complete',
    usage: null,
    providerSlug: null,
    modelId: null,
    artifactId: null,
    author,
    createdAt: `2026-07-26T00:00:${String(seq).padStart(2, '0')}.000Z`
  }
}

describe('renderGroupDeliverables', () => {
  it('拼出目录 + 各交付物,并把文档降一级避免和整份标题打架', () => {
    const out = renderGroupDeliverables(
      GROUP,
      [
        say(PM, `# 需求文档:记账\n\n正文甲\n\n@[架构师](member:${ARCH}) 出领域模型`),
        say(ARCH, '# 架构设计文档\n\n正文乙')
      ],
      MEMBERS
    )

    expect(out.startsWith('# 记账 App')).toBe(true)
    expect(out).toContain('本轮交付 2/2 项')
    expect(out).toContain('1. 需求文档:记账 —— @产品经理')
    // 各文档自己是一级标题,导出里要降成二级
    expect(out).toContain('## 需求文档:记账')
    expect(out).not.toMatch(/^# 需求文档/m)
    expect(out).toContain('> 由 @产品经理 交付')
  })

  it('剥掉末尾交接行,并且不把 ULID 带进交付物', () => {
    const out = renderGroupDeliverables(
      GROUP,
      [say(PM, `# 需求文档\n\n正文\n\n@[架构师](member:${ARCH}) 出领域模型`)],
      MEMBERS
    )
    expect(out).not.toContain('出领域模型')
    expect(out).not.toContain(ARCH)
  })

  it('讨论、汇总、未交付的都不进正文,但未交付要在目录里点名', () => {
    const out = renderGroupDeliverables(
      GROUP,
      [say(PM, '# 需求文档\n\n正文'), say(ARCH, '我先看看资料'), say(PM, '## 汇总\n\n没有冲突')],
      MEMBERS
    )
    expect(out).toContain('本轮交付 1/2 项')
    expect(out).toContain('(未交付)架构设计文档 —— @架构师')
    expect(out).not.toContain('我先看看资料')
    expect(out).not.toContain('没有冲突')
  })

  it('一条都没有时也给一份说得清的空文件,而不是空白', () => {
    const out = renderGroupDeliverables(GROUP, [], MEMBERS)
    expect(out).toContain('本轮没有交付物')
  })
})
