import { describe, expect, it, vi } from 'vitest'
import type { Message } from '../../shared/types'
import { buildGroupTranscript, transcriptEntries, transcriptFoldIds } from './group-transcript'

/**
 * 分层 transcript 的行为契约。
 *
 * 真实案例:13 棒接力累计 22 万字,最后一棒输入 89k token,超过成员模型
 * 64k 的窗口——中转站静默截头,最先被砍的恰是用户原始诉求。这组测试钉住
 * 三条铁律(用户消息 / 各成员最新发言 / 上一棒永不折叠)和纪要替换语义。
 */

const PM = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: '产品经理' }
const ARCH = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAW', name: '架构师' }
const MEMBERS = [PM, ARCH]

let seq = 0
function message(author: string, text: string, status: Message['status'] = 'complete'): Message {
  seq++
  return {
    id: `msg-${String(seq).padStart(3, '0')}`,
    conversationId: 'group-1',
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

/** 造一篇带标题结构的长文,结尾是交接行 */
function longDoc(title: string, chars: number, handoff: string): string {
  const body = '正'.repeat(chars)
  return `# ${title}\n\n## 第一章\n${body}\n\n## 第二章\n收尾。\n\n${handoff}`
}

describe('未超预算:全量保留', () => {
  it('所有发言原文进入 transcript,结构化提及转成 @名字', () => {
    const messages = [
      message('user', `@[产品经理](member:${PM.id}) 开始吧`),
      message(PM.id, `# 需求\n内容\n\n@[架构师](member:${ARCH.id}) 请接棒`)
    ]

    const out = buildGroupTranscript({
      messages,
      excludeId: 'none',
      selfName: '架构师',
      members: MEMBERS,
      contextWindow: 64_000
    })

    expect(out).toContain('【用户】')
    expect(out).toContain('@产品经理 开始吧')
    expect(out).toContain('# 需求')
    expect(out).not.toContain('(member:')
    expect(out).toContain('现在轮到你(架构师)发言')
  })

  it('不折叠时不读纪要——多数会话不该为此多一次查库', () => {
    const loadDigest = vi.fn(() => null)
    buildGroupTranscript({
      messages: [message('user', '短消息')],
      excludeId: 'none',
      selfName: '产品经理',
      members: MEMBERS,
      contextWindow: 64_000,
      loadDigest
    })

    expect(loadDigest).not.toHaveBeenCalled()
  })

  it('上一棒结尾的交接指令被重述在末尾', () => {
    const messages = [
      message('user', '开始'),
      message(PM.id, longDoc('需求文档', 100, '@架构师 请输出领域模型与部署架构'))
    ]

    const out = buildGroupTranscript({
      messages,
      excludeId: 'none',
      selfName: '架构师',
      members: MEMBERS,
      contextWindow: 64_000
    })

    expect(out).toContain('【产品经理】交给你的任务')
    expect(out).toContain('> @架构师 请输出领域模型与部署架构')
  })

  /**
   * 并行接力下"记录里的最后一条"未必是交接给我的那位——兄弟分支可能后收棒。
   * 编排显式带下来的任务必须压过从记录里倒推的那份。
   */
  it('编排显式给的任务覆盖从记录里倒推的交接', () => {
    const messages = [
      message('user', '@全栈工程师 改 schema。@技术评审员 验证方案'),
      message(PM.id, longDoc('需求文档', 10, '@架构师 请输出领域模型'))
    ]

    const out = buildGroupTranscript({
      messages,
      excludeId: 'none',
      selfName: '架构师',
      members: MEMBERS,
      contextWindow: 64_000,
      assignment: { from: '用户', line: '验证方案是否满足需求规格说明书' }
    })

    expect(out).toContain('【用户】交给你的任务')
    expect(out).toContain('> 验证方案是否满足需求规格说明书')
    expect(out).not.toContain('> @架构师 请输出领域模型')
  })
})

describe('超预算折叠:三条铁律', () => {
  // contextWindow=1000 → 预算取下限 24000 字符,四篇 1 万字文档必然触发折叠
  const WINDOW = 1000

  function bulkyMessages(): Message[] {
    return [
      message('user', '把重卡项目落地方案做出来'),
      message(PM.id, longDoc('需求文档v1', 10_000, '@架构师 请设计架构')),
      message(ARCH.id, longDoc('架构设计', 10_000, '@产品经理 请修订需求')),
      message(PM.id, longDoc('需求文档修订', 10_000, '@架构师 请复核')),
      message(ARCH.id, longDoc('架构复核', 10_000, '@产品经理 请确认'))
    ]
  }

  it('折叠最老的、已有后续发言的条目;用户消息/各成员最新/上一棒保全文', () => {
    const entries = transcriptEntries(bulkyMessages(), MEMBERS)
    const folded = transcriptFoldIds(entries, WINDOW)

    // 可折叠的只有 PM 的 v1 与架构师的首篇(各自都有更新的发言);
    // 末条(上一棒)与 PM 修订(PM 最新)受保护
    expect(folded).toEqual([entries[1].id, entries[2].id])
  })

  it('折叠条目降级为结构存根:保标题骨架与结尾交接行', () => {
    const out = buildGroupTranscript({
      messages: bulkyMessages(),
      excludeId: 'none',
      selfName: '产品经理',
      members: MEMBERS,
      contextWindow: WINDOW
    })

    expect(out).toContain('已折叠')
    expect(out).toContain('# 需求文档v1')
    expect(out).toContain('(结尾交接:@架构师 请设计架构)')
    // 用户消息与最新文档必须原文在场
    expect(out).toContain('把重卡项目落地方案做出来')
    expect(out).toContain('# 需求文档修订\n\n## 第一章\n正')
    expect(out).toContain('# 架构复核\n\n## 第一章\n正')
  })

  it('纪要覆盖范围内的折叠条目由一个纪要块整体替换', () => {
    const messages = bulkyMessages()
    const entries = transcriptEntries(messages, MEMBERS)
    const [first, second] = transcriptFoldIds(entries, WINDOW)

    const out = buildGroupTranscript({
      messages,
      excludeId: 'none',
      selfName: '产品经理',
      members: MEMBERS,
      contextWindow: WINDOW,
      // 纪要只覆盖到第一条折叠消息:第二条应保持机械存根
      loadDigest: () => ({ text: '既往结论:一期只做充电调度。', coveredUntilId: first })
    })

    expect(out).toContain('【前情纪要】')
    expect(out).toContain('既往结论:一期只做充电调度。')
    // 被纪要覆盖的 v1 全文与存根都不再出现
    expect(out).not.toContain('# 需求文档v1')
    // 覆盖之外的折叠条目仍是存根
    expect(out).toContain('# 架构设计')
    expect(out).toContain(`全文 ${entries.find((e) => e.id === second)!.text.length} 字`)
  })

  it('一档折不够时二档连成员最新发言也折,但上一棒和用户消息仍保全文', () => {
    // 三篇 3 万字巨文,预算 24000:折掉前两篇(含 PM 的最新一篇)才够
    const messages = [
      message('user', '开始'),
      message(PM.id, longDoc('需求', 30_000, '@架构师 接棒')),
      message(ARCH.id, longDoc('架构一稿', 30_000, '@产品经理 修订')),
      message(ARCH.id, longDoc('架构二稿', 30_000, '@产品经理 确认'))
    ]
    const entries = transcriptEntries(messages, MEMBERS)
    const folded = transcriptFoldIds(entries, 1000)

    // 一档:架构一稿(旧且有更新);二档:PM 需求(最新但预算不够);末条永不折
    expect(folded).toEqual([entries[1].id, entries[2].id])
  })
})

describe('流式中的半条消息', () => {
  it('不进 transcript', () => {
    const messages = [message('user', '开始'), message(PM.id, '写了一半的', 'streaming')]

    const out = buildGroupTranscript({
      messages,
      excludeId: 'none',
      selfName: '架构师',
      members: MEMBERS
    })

    expect(out).not.toContain('写了一半的')
  })
})
