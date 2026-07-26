import { parse } from 'comark'
import { describe, expect, it } from 'vitest'
import {
  createGroupMention,
  firstMention,
  mentionsToMarkdown,
  mentionsToModelText,
  nextMention,
  tokenizeGroupMentions,
  type GroupMentionMember
} from './group-mentions'

const PM_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const UI_ID = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
const FE_ID = '01KYDQZR8VGYDVT4B8V8439EAH'

const MEMBERS: GroupMentionMember[] = [
  { id: PM_ID, name: '产品经理' },
  { id: UI_ID, name: 'UI 设计师' },
  { id: FE_ID, name: '产品' }
]

function collectComarkNodeTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ownType =
    typeof value[0] === 'string' &&
    value[1] != null &&
    typeof value[1] === 'object' &&
    !Array.isArray(value[1])
      ? [value[0]]
      : []
  return [...ownType, ...value.flatMap(collectComarkNodeTypes)]
}

describe('createGroupMention', () => {
  it('为新成员生成带稳定 ULID 的规范提及', () => {
    expect(createGroupMention(MEMBERS[1])).toBe(`@[UI 设计师](member:${UI_ID})`)
  })

  it('拒绝内置角色 ID，已创建成员只能使用 ULID', () => {
    expect(() => createGroupMention({ id: 'pm', name: '产品经理' })).toThrow(/ULID/)
  })

  it('含反引号的名称可在规范提及中可逆往返', async () => {
    const member = { id: PM_ID, name: '前`端`' }
    const mention = createGroupMention(member)

    expect(mention).toBe('@[前\\`端\\`](member:' + PM_ID + ')')
    expect(tokenizeGroupMentions(mention, [member])).toEqual([
      { type: 'member', memberId: PM_ID, name: member.name }
    ])
    expect(mentionsToModelText(mention, [member])).toBe('@前`端`')

    const markdown = mentionsToMarkdown(mention, [member])
    expect(markdown).toBe('[@前&#96;端&#96;](group-member:' + PM_ID + ')')
    await expect(parse(markdown)).resolves.toMatchObject({
      nodes: [['p', {}, ['a', { href: `group-member:${PM_ID}` }, '@前`端`']]]
    })
  })
})

describe('tokenizeGroupMentions', () => {
  it('只把当前成员表中名称与 ULID 都匹配的规范提及转成 member token', () => {
    const valid = `请 @[产品经理](member:${PM_ID}) 开始`
    expect(tokenizeGroupMentions(valid, MEMBERS)).toEqual([
      { type: 'text', text: '请 ' },
      { type: 'member', memberId: PM_ID, name: '产品经理' },
      { type: 'text', text: ' 开始' }
    ])

    const invalid = [
      `@[产品](member:${PM_ID})`,
      '@[产品经理](member:not-an-ulid)',
      '@[陌生人](member:01J00000000000000000000000)'
    ].join(' ')
    expect(tokenizeGroupMentions(invalid, MEMBERS)).toEqual([{ type: 'text', text: invalid }])
  })

  it('按完整名称边界识别自然名称提及，相似名称不误匹配', () => {
    expect(tokenizeGroupMentions('@产品经理 交给 @产品；@产品经理助理 不在群里', MEMBERS)).toEqual([
      { type: 'member', memberId: PM_ID, name: '产品经理' },
      { type: 'text', text: ' 交给 ' },
      { type: 'member', memberId: FE_ID, name: '产品' },
      { type: 'text', text: '；@产品经理助理 不在群里' }
    ])
  })

  it('支持名称中的空格', () => {
    expect(tokenizeGroupMentions('@UI 设计师 请接棒', MEMBERS)).toEqual([
      { type: 'member', memberId: UI_ID, name: 'UI 设计师' },
      { type: 'text', text: ' 请接棒' }
    ])
  })

  it('自然格式支持名称中成对出现的反引号', () => {
    const member = { id: PM_ID, name: '前`端`' }
    const text = '请 @前`端` 接棒'

    expect(tokenizeGroupMentions(text, [member])).toEqual([
      { type: 'text', text: '请 ' },
      { type: 'member', memberId: PM_ID, name: member.name },
      { type: 'text', text: ' 接棒' }
    ])
    expect(firstMention(text, [member])).toBe(PM_ID)
  })

  it('代码围栏与行内代码中的提及保持普通文本', () => {
    const text = [
      '`@产品经理` 与 @产品经理',
      '```md',
      `@[UI 设计师](member:${UI_ID})`,
      '@产品',
      '```',
      '@UI 设计师'
    ].join('\n')

    expect(tokenizeGroupMentions(text, MEMBERS)).toEqual([
      { type: 'text', text: '`@产品经理` 与 ' },
      { type: 'member', memberId: PM_ID, name: '产品经理' },
      {
        type: 'text',
        text: ['\n```md', `@[UI 设计师](member:${UI_ID})`, '@产品', '```\n'].join('\n')
      },
      { type: 'member', memberId: UI_ID, name: 'UI 设计师' }
    ])
  })

  it('blockquote 与列表容器中的代码围栏不解析提及', () => {
    const text = [
      '> ~~~md',
      '> @产品经理',
      '> ~~~',
      '- ~~~md',
      '  @UI 设计师',
      '  ~~~',
      '@产品'
    ].join('\n')

    expect(tokenizeGroupMentions(text, MEMBERS)).toEqual([
      { type: 'text', text: `${text.slice(0, text.lastIndexOf('@产品'))}` },
      { type: 'member', memberId: FE_ID, name: '产品' }
    ])
  })

  it('不同 Markdown 容器中的围栏不能互相关闭', () => {
    const quotedOpen = ['> ```md', '> @产品经理', '```', '@UI 设计师'].join('\n')
    const plainOpen = ['```md', '@产品经理', '> ```', '@UI 设计师'].join('\n')

    expect(tokenizeGroupMentions(quotedOpen, MEMBERS)).toEqual([{ type: 'text', text: quotedOpen }])
    expect(tokenizeGroupMentions(plainOpen, MEMBERS)).toEqual([{ type: 'text', text: plainOpen }])
  })

  it('容器内未闭合围栏在 blockquote 或列表结束时停止', () => {
    const quoted = ['> ```md', '> @产品经理', '块外 @UI 设计师'].join('\n')
    const listed = ['- ~~~md', '  @产品经理', '块外 @UI 设计师'].join('\n')

    expect(firstMention(quoted, MEMBERS)).toBe(UI_ID)
    expect(firstMention(listed, MEMBERS)).toBe(UI_ID)
  })

  it('列表 fence 的无缩进空行不会结束容器，后续段落仍是代码', () => {
    const text = ['- ```md', '  @产品经理', '', '  第二段 @UI 设计师', '  ```', '@产品'].join('\n')

    expect(firstMention(text, MEMBERS)).toBe(FE_ID)
  })

  it('tab 可按下一个四列制表位满足列表 continuation 与关闭缩进', () => {
    const text = ['- ```md', '\t@UI 设计师', '\t```', '@产品'].join('\n')

    expect(firstMention(text, MEMBERS)).toBe(FE_ID)
  })

  it('inline backtick 不能把合法 fence delimiter 当作关闭 run', () => {
    const text = ['prefix ```', '```md', '@UI 设计师'].join('\n')

    expect(tokenizeGroupMentions(text, MEMBERS)).toEqual([{ type: 'text', text }])
    expect(firstMention(text, MEMBERS)).toBeNull()
  })

  it('inline backtick run 不跨空行与下一段配对', () => {
    const text = ['`unclosed', '', '`@UI 设计师`'].join('\n')

    expect(firstMention(text, MEMBERS)).toBeNull()
  })

  it.each([
    ['heading', '# '],
    ['list', '- '],
    ['blockquote', '> ']
  ])('inline backtick run 不跨 %s 块边界配对', (_, prefix) => {
    const text = ['`unclosed', `${prefix}\`@UI 设计师\``].join('\n')

    expect(firstMention(text, MEMBERS)).toBeNull()
  })

  it.each(['===', '  === \t'])(
    'inline backtick run 不跨 Setext 等号下划线 %j 配对',
    (underline) => {
      const text = ['`unclosed', underline, '`@UI 设计师`'].join('\n')

      expect(firstMention(text, MEMBERS)).toBeNull()
    }
  )

  it('同一普通段落内的 code span 仍可跨 soft line break', () => {
    const text = ['`跨行', '@UI 设计师` @产品'].join('\n')

    expect(firstMention(text, MEMBERS)).toBe(FE_ID)
  })

  it('backtick fence 的 info string 含反引号时不视为围栏', () => {
    const text = ['```md`invalid', '@UI 设计师'].join('\n')

    expect(firstMention(text, MEMBERS)).toBe(UI_ID)
  })

  it('大量不同长度的反引号 run 不会反复扫描文本后缀', () => {
    const text = Array.from({ length: 350 }, (_, index) => `${'`'.repeat(index + 1)}x`).join('')
    const startedAt = performance.now()

    expect(tokenizeGroupMentions(text, MEMBERS)).toEqual([{ type: 'text', text }])
    expect(performance.now() - startedAt).toBeLessThan(1_500)
  })
})

describe('提及转换', () => {
  it('给模型的文本统一为可读的 @名称，代码内容保持原样', () => {
    const text = `请 @[产品经理](member:${PM_ID}) 看 \`@[UI 设计师](member:${UI_ID})\``
    expect(mentionsToModelText(text, MEMBERS)).toBe(
      `请 @产品经理 看 \`@[UI 设计师](member:${UI_ID})\``
    )
  })

  it('展示转换只生成安全的 group-member Markdown link，不输出 HTML', () => {
    const text = `@[产品经理](member:${PM_ID}) 和 @UI 设计师`
    const markdown = mentionsToMarkdown(text, MEMBERS)

    expect(markdown).toBe(
      `[@产品经理](group-member:${PM_ID}) 和 [@UI 设计师](group-member:${UI_ID})`
    )
    expect(markdown).not.toContain('<')
  })

  it('合法名称中的 HTML 标签只生成文本 AST，同时保留显示语义', async () => {
    const member = { id: PM_ID, name: '<img src=x onerror=evil>' }
    const markdown = mentionsToMarkdown(`@${member.name}`, [member])
    const tree = await parse(markdown)

    expect(markdown).toBe(`[@&#60;img src&#61;x onerror&#61;evil&#62;](group-member:${PM_ID})`)
    expect(collectComarkNodeTypes(tree.nodes)).toContain('a')
    expect(collectComarkNodeTypes(tree.nodes)).not.toContain('img')
    expect(tree.nodes).toEqual([
      ['p', {}, ['a', { href: `group-member:${PM_ID}` }, '@<img src=x onerror=evil>']]
    ])
  })

  it.each([
    ['研究**员**', '研究&#42;&#42;员&#42;&#42;'],
    ['研究_员 &copy;', '研究&#95;员 &#38;copy&#59;']
  ])('成员名 %s 的 Markdown 标点只生成单一纯文本 label', async (name, encodedName) => {
    const member = { id: PM_ID, name }
    const markdown = mentionsToMarkdown(`@${name}`, [member])
    const tree = await parse(markdown)

    expect(markdown).toBe(`[@${encodedName}](group-member:${PM_ID})`)
    expect(tree.nodes).toEqual([['p', {}, ['a', { href: `group-member:${PM_ID}` }, `@${name}`]]])
  })
})

describe('提及路由', () => {
  it('用户第一棒取文本顺序中的第一个有效成员', () => {
    const text = `@[伪造](member:${PM_ID}) 然后 @UI 设计师，再 @产品经理`
    expect(firstMention(text, MEMBERS)).toBe(UI_ID)
  })

  it('Agent 只从末尾五行选择下一棒', () => {
    const text = ['@产品经理', ...Array(5).fill('正文'), '@UI 设计师'].join('\n')
    expect(nextMention(text, MEMBERS, PM_ID)).toBe(UI_ID)

    const outsideTail = ['@UI 设计师', ...Array(5).fill('正文')].join('\n')
    expect(nextMention(outsideTail, MEMBERS, PM_ID)).toBeNull()
  })

  it('Agent 忽略自我提及并继续选择文本顺序中的其他成员', () => {
    expect(nextMention('@产品经理 复核，再请 @UI 设计师 接棒', MEMBERS, PM_ID)).toBe(UI_ID)
  })

  it('末尾五行出现非代码区 @用户 时优先正常结束', () => {
    expect(nextMention('@UI 设计师 接棒\n@用户 也可以直接验收', MEMBERS, PM_ID)).toBeNull()
    expect(nextMention('`@用户`\n@UI 设计师 接棒', MEMBERS, PM_ID)).toBe(UI_ID)
  })

  it('围栏起点在末尾五行之前时，围栏内提及仍不参与路由', () => {
    const text = ['```md', ...Array(5).fill('正文'), '@UI 设计师', '```'].join('\n')
    expect(nextMention(text, MEMBERS, PM_ID)).toBeNull()
  })

  it('末尾 blockquote 代码围栏中的提及不参与路由', () => {
    expect(nextMention('> ~~~md\n> @UI 设计师\n> ~~~', MEMBERS, PM_ID)).toBeNull()
  })
})
