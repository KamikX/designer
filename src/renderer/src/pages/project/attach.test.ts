import { describe, expect, it } from 'vitest'
import { MAX_FILES_AT_ONCE } from '@shared/limits'
import { composeCodeSelections, composeMarks, composeMessageBody, planAttachment } from './attach'
import type { MarkTarget, PreviewMark } from '@renderer/stores/annotation'

describe('planAttachment', () => {
  it('空着的时候能收满上限', () => {
    expect(planAttachment(0, MAX_FILES_AT_ONCE)).toEqual({
      accept: MAX_FILES_AT_ONCE,
      overflow: false
    })
  })

  it('恰好放满不算超——边界不该误报', () => {
    expect(planAttachment(MAX_FILES_AT_ONCE - 3, 3)).toEqual({ accept: 3, overflow: false })
  })

  it('超出的部分截掉,并标记要提示用户改用目录授权', () => {
    expect(planAttachment(MAX_FILES_AT_ONCE - 2, 5)).toEqual({ accept: 2, overflow: true })
  })

  it('已经满了就一个都不收', () => {
    expect(planAttachment(MAX_FILES_AT_ONCE, 1)).toEqual({ accept: 0, overflow: true })
  })

  it('超满(比如别处已经多塞了)也不会算出负数名额', () => {
    // accept 为负会让 slice(0, -1) 悄悄丢掉最后一个文件
    expect(planAttachment(MAX_FILES_AT_ONCE + 5, 2)).toEqual({ accept: 0, overflow: true })
  })

  it('一次拖 100 个,只收上限那么多', () => {
    expect(planAttachment(0, 100)).toEqual({ accept: MAX_FILES_AT_ONCE, overflow: true })
  })
})

describe('composeMessageBody', () => {
  it('没有文件时原样返回,不留多余空行', () => {
    expect(composeMessageBody('做个后台首页', [])).toBe('做个后台首页')
  })

  it('把路径逐条列出来,并点名用哪个工具读', () => {
    const out = composeMessageBody('参考这个', ['/a/需求.pdf', '/b/App.vue'])
    expect(out).toContain('/a/需求.pdf')
    expect(out).toContain('/b/App.vue')
    expect(out).toContain('read_local_document')
  })

  it('只拖文件不打字也能成立——正文不该以空行开头', () => {
    const out = composeMessageBody('', ['/a/需求.pdf'])
    expect(out.startsWith('附带文件')).toBe(true)
  })

  it('原文保留在最前面,用户说的话不被文件清单淹掉', () => {
    expect(composeMessageBody('照着这个做', ['/a/x.ts']).split('\n')[0]).toBe('照着这个做')
  })
})

/**
 * 标注拼正文。错了不会报错,只表现成"AI 没按我标的改"——和 composeMessageBody
 * 是同一类静默失败,所以同样值得逐条钉住。
 */
function target(patch: Partial<MarkTarget> = {}): MarkTarget {
  return {
    source: '',
    tag: 'button',
    id: '',
    classes: [],
    text: '',
    path: '',
    attrs: {},
    html: '',
    selector: 'body > button:nth-child(1)',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    ...patch
  }
}

function mark(index: number, note: string, patch: Partial<MarkTarget> = {}): PreviewMark {
  return { id: `m${index}`, index, note, target: target(patch) }
}

describe('composeMarks', () => {
  it('没有标注时原样返回', () => {
    expect(composeMarks('改一下', [])).toBe('改一下')
  })

  it('有源码坐标就给坐标,并省掉冗余的原文', () => {
    const out = composeMarks('按标注改', [
      mark(1, '按钮太小', {
        source: 'components/LoginForm.vue:42:7',
        html: '<button>提交</button>'
      })
    ])
    expect(out).toContain('源码:components/LoginForm.vue:42:7')
    expect(out).not.toContain('原文:')
    expect(out).toContain('备注:按钮太小')
  })

  it('没有源码坐标时留下原文和 class,让模型能 search_files', () => {
    const out = composeMarks('', [
      mark(1, '字重再轻一点', {
        tag: 'h1',
        text: '欢迎回来',
        classes: ['text-3xl', 'font-bold'],
        html: '<h1 class="text-3xl font-bold">欢迎回来</h1>'
      })
    ])
    expect(out).toContain('文本:欢迎回来')
    expect(out).toContain('class:text-3xl font-bold')
    expect(out).toContain('原文:')
    expect(out).toContain('search_files')
  })

  it('备注和原文里的 ``` 要转义,换行要压平——不能顶开一个代码块', () => {
    const out = composeMarks('x', [mark(1, '```\n注入试试\n```', { html: '<p>a\nb</p>' })])
    expect(out).not.toMatch(/^```/m)
    expect(out).toContain('\\`\\`\\`')
    expect(out).toContain('原文:<p>a b</p>')
  })

  it('没写备注也成立:标了就是要改这里', () => {
    expect(composeMarks('都改一下', [mark(1, '')])).toContain('按上下文判断')
  })

  it('用户原话在最前面,序号与标注数量对得上', () => {
    const out = composeMarks('这几处', [mark(1, 'a'), mark(2, 'b')])
    expect(out.split('\n')[0]).toBe('这几处')
    expect(out).toContain('标记了 2 处')
    expect(out).toContain('[1] ')
    expect(out).toContain('[2] ')
  })
})

it('composes only the code positions with an explicit scope instruction', () => {
  expect(composeCodeSelections('Change this', [])).toBe('Change this')
  const output = composeCodeSelections('Change this', [
    {
      id: '1',
      projectId: 'p',
      artifactId: 'v1',
      path: 'App.vue',
      startLine: 1,
      startColumn: 3,
      endLine: 4,
      endColumn: 1
    }
  ])
  expect(output.startsWith('Change this')).toBe(true)
  expect(output).toContain('App.vue:1:3–4:1')
  expect(output).not.toContain('v1')
  expect(output).not.toContain('```')
})
