import { describe, expect, it } from 'vitest'
import { FileStreamParser } from './file-stream-parser'
import type { ParserEvent } from './file-stream-parser'

/** 把整段输出按给定 chunk 尺寸切碎喂给解析器,模拟任意流式切分 */
function feed(
  input: string,
  chunkSize: number
): { parser: FileStreamParser; events: ParserEvent[] } {
  const parser = new FileStreamParser()
  const events: ParserEvent[] = []
  for (let i = 0; i < input.length; i += chunkSize) {
    events.push(...parser.push(input.slice(i, i + chunkSize)))
  }
  events.push(...parser.finish())
  return { parser, events }
}

const SAMPLE = [
  '来做一个落地页。',
  '<antdFile path="index.html">',
  '<!doctype html>',
  '<div class="hero">你好</div>',
  '</antdFile>',
  '<antdFile path="css/style.css">',
  '.hero { color: red; }',
  '</antdFile>',
  '<antdDelete path="old.css" />',
  '完成了。'
].join('\n')

describe('FileStreamParser', () => {
  // 任意切分尺寸下结果都必须一致——这是流式解析器的核心不变量
  for (const size of [1, 3, 7, 1000]) {
    it(`chunk=${size} 时解析结果一致`, () => {
      const { parser, events } = feed(SAMPLE, size)

      expect([...parser.files.keys()]).toEqual(['index.html', 'css/style.css'])
      expect(parser.files.get('index.html')).toBe('<!doctype html>\n<div class="hero">你好</div>\n')
      expect(parser.files.get('css/style.css')).toBe('.hero { color: red; }\n')
      expect([...parser.deleted]).toEqual(['old.css'])
      expect(parser.narration).toContain('来做一个落地页。')
      expect(parser.narration).toContain('完成了。')
      expect(parser.narration).not.toContain('antdFile')

      const starts = events.filter((e) => e.type === 'file-start').map((e) => e.path)
      const ends = events.filter((e) => e.type === 'file-end').map((e) => e.path)
      expect(starts).toEqual(['index.html', 'css/style.css'])
      expect(ends).toEqual(starts)
    })
  }

  it('文件体里的 markdown 围栏不干扰解析', () => {
    const input = [
      '<antdFile path="README.md">',
      '```js',
      'const a = 1',
      '```',
      '</antdFile>'
    ].join('\n')
    const { parser } = feed(input, 5)
    expect(parser.files.get('README.md')).toBe('```js\nconst a = 1\n```\n')
  })

  it('流中断未闭合时自动收尾,已生成内容可用', () => {
    const input = ['<antdFile path="a.html">', '<p>部分内容'].join('\n')
    const { parser, events } = feed(input, 4)
    expect(parser.files.get('a.html')).toBe('<p>部分内容\n')
    expect(events.filter((e) => e.type === 'file-end')).toHaveLength(1)
  })

  it('删除后重写同一文件以重写为准', () => {
    const input = [
      '<antdDelete path="a.css" />',
      '<antdFile path="a.css">',
      'body {}',
      '</antdFile>'
    ].join('\n')
    const { parser } = feed(input, 9)
    expect(parser.deleted.has('a.css')).toBe(false)
    expect(parser.files.get('a.css')).toBe('body {}\n')
  })

  it('纯文本(无任何标记)原样透传', () => {
    const { parser, events } = feed('第一行\n第二行没有换行结尾', 2)
    expect(parser.hasChanges).toBe(false)
    const text = events
      .filter((e) => e.type === 'text')
      .map((e) => (e.type === 'text' ? e.text : ''))
      .join('')
    expect(text).toBe('第一行\n第二行没有换行结尾')
  })

  it('正文里的普通 HTML 标签不会被误认成标记', () => {
    const { parser } = feed('用 <antd-button> 组件\n<div>hi</div>\n', 3)
    expect(parser.hasChanges).toBe(false)
    expect(parser.narration).toBe('用 <antd-button> 组件\n<div>hi</div>\n')
  })

  for (const size of [1, 3, 7, 1000]) {
    it(`chunk=${size} 时暂存多行视觉方向且不泄漏到正文`, () => {
      const { parser, events } = feed(
        [
          '先说明方案。',
          '<antdStyleBrief>',
          '  冷灰、紧凑',
          '  高信息密度  ',
          '</antdStyleBrief>',
          '<antdFile path="index.html">',
          '<main />',
          '</antdFile>'
        ].join('\n'),
        size
      )

      expect(parser.pendingStyleBrief).toBe('冷灰、紧凑\n  高信息密度')
      expect(parser.narration).toBe('先说明方案。\n')
      expect(parser.hasChanges).toBe(true)
      expect(
        events.some((event) => event.type === 'text' && event.text.includes('StyleBrief'))
      ).toBe(false)
    })
  }

  it('多个完整视觉方向以最后一个为准，空正文表示清除', () => {
    const { parser } = feed(
      [
        '<antdStyleBrief>',
        '旧方向',
        '</antdStyleBrief>',
        '<antdStyleBrief>',
        '   ',
        '</antdStyleBrief>'
      ].join('\n'),
      4
    )

    expect(parser.pendingStyleBrief).toBe('')
  })

  for (const size of [1, 3, 7, 1000]) {
    it(`chunk=${size} 时解析兜底风格标记而不写入正文或文件`, () => {
      const { parser, events } = feed('<antdUseStyleFallback />\n继续说明', size)

      expect(parser.useStyleFallback).toBe(true)
      expect(parser.narration).toBe('继续说明')
      expect(parser.hasChanges).toBe(false)
      expect(events.some((event) => event.type !== 'text')).toBe(false)
    })
  }

  it('未闭合视觉方向会被丢弃且不泄漏到正文', () => {
    const { parser } = feed('<antdStyleBrief>\n绝不能出现在用户消息里', 3)

    expect(parser.pendingStyleBrief).toBeUndefined()
    expect(parser.narration).toBe('')
  })

  it('保留自动收尾文件的兼容行为，同时记录其原本未闭合', () => {
    const { parser } = feed('<antdFile path="a.html">\n<p>半截', 7)

    expect(parser.files.get('a.html')).toBe('<p>半截\n')
    expect(parser.hadUnclosedFile).toBe(true)
  })
})
