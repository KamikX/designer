import { describe, expect, it } from 'vitest'
import { AnchorError, AnchorRegistry } from './anchor-registry'

/**
 * 锚点坐标契约:输入 1 起、两端行/列均包含;内部统一为 UTF-16 code unit
 * 的半开区间 [startOffset, endOffset)。所有锚点非空。
 */

const CONTENT = ['const a = 1', 'const emoji = "😀好"', '', 'done'].join('\n')

function registry(): AnchorRegistry {
  return new AnchorRegistry()
}

describe('坐标转换', () => {
  it('整行:列缺省取行首到行尾', () => {
    const reg = registry()
    const { anchor, text } = reg.capture('a.ts', 1, CONTENT, { startLine: 1 })
    expect(text).toBe('const a = 1')
    expect(anchor.startOffset).toBe(0)
    expect(anchor.endOffset).toBe(11)
  })

  it('end_line 缺省等于起始行;跨行区间到结束行行尾', () => {
    const reg = registry()
    const { text } = reg.capture('a.ts', 1, CONTENT, { startLine: 1, endLine: 2 })
    expect(text).toBe('const a = 1\nconst emoji = "😀好"')
  })

  it('列是 1 起、包含端点,按 UTF-16 code unit 计数', () => {
    const reg = registry()
    // 第 1 行 "const a = 1":取第 7-7 列即 "a"
    const { text } = reg.capture('a.ts', 1, CONTENT, {
      startLine: 1,
      startColumn: 7,
      endColumn: 7
    })
    expect(text).toBe('a')
  })

  it('emoji 是两个 code unit,列号按 code unit 走', () => {
    const reg = registry()
    // 第 2 行 `const emoji = "😀好"`:😀 占 16-17 两列
    const { text } = reg.capture('a.ts', 1, CONTENT, {
      startLine: 2,
      startColumn: 16,
      endColumn: 17
    })
    expect(text).toBe('😀')
  })

  it('切在 surrogate pair 中间被拒绝', () => {
    const reg = registry()
    expect(() =>
      reg.capture('a.ts', 1, CONTENT, { startLine: 2, startColumn: 17, endColumn: 18 })
    ).toThrow(AnchorError)
  })

  it('include_trailing_newline 把结束行的换行并进来', () => {
    const reg = registry()
    const { text } = reg.capture('a.ts', 1, CONTENT, {
      startLine: 1,
      includeTrailingNewline: true
    })
    expect(text).toBe('const a = 1\n')
  })

  it('最后一行没有换行时 include_trailing_newline 报错', () => {
    const reg = registry()
    expect(() =>
      reg.capture('a.ts', 1, CONTENT, { startLine: 4, includeTrailingNewline: true })
    ).toThrow(AnchorError)
  })

  it('CRLF 文件:行内容不含 \\r,换行按 \\r\\n 整体并入', () => {
    const reg = registry()
    const crlf = 'line1\r\nline2\r\n'
    const one = reg.capture('a.ts', 1, crlf, { startLine: 1 })
    expect(one.text).toBe('line1')
    const withNl = reg.capture('a.ts', 1, crlf, { startLine: 1, includeTrailingNewline: true })
    expect(withNl.text).toBe('line1\r\n')
  })

  it('空区间被拒绝:所有锚点必须非空', () => {
    const reg = registry()
    // 第 3 行是空行
    expect(() => reg.capture('a.ts', 1, CONTENT, { startLine: 3 })).toThrow(AnchorError)
  })

  it('越界行/列给结构化错误', () => {
    const reg = registry()
    expect(() => reg.capture('a.ts', 1, CONTENT, { startLine: 99 })).toThrow(AnchorError)
    expect(() => reg.capture('a.ts', 1, CONTENT, { startLine: 1, startColumn: 99 })).toThrow(
      AnchorError
    )
    expect(() => reg.capture('a.ts', 1, CONTENT, { startLine: 2, endLine: 1 })).toThrow(AnchorError)
  })

  it('中文文本逐字符定位', () => {
    const reg = registry()
    const zh = '第一行中文\n第二行'
    const { text } = reg.capture('a.ts', 1, zh, { startLine: 1, startColumn: 4, endColumn: 5 })
    expect(text).toBe('中文')
  })
})

describe('失效与校验', () => {
  it('resolve 校验 revision:文件变了的锚点报 ANCHOR_STALE', () => {
    const reg = registry()
    const { anchor } = reg.capture('a.ts', 1, CONTENT, { startLine: 1 })
    expect(reg.resolve(anchor.id, 1, CONTENT)).toMatchObject({ id: anchor.id })
    try {
      reg.resolve(anchor.id, 2, CONTENT)
      expect.unreachable()
    } catch (err) {
      expect((err as AnchorError).code).toBe('ANCHOR_STALE')
    }
  })

  it('resolve 校验内容 hash:同 revision 但内容对不上也算失效', () => {
    const reg = registry()
    const { anchor } = reg.capture('a.ts', 1, CONTENT, { startLine: 1 })
    const tampered = CONTENT.replace('const a', 'const b')
    try {
      reg.resolve(anchor.id, 1, tampered)
      expect.unreachable()
    } catch (err) {
      expect((err as AnchorError).code).toBe('ANCHOR_STALE')
    }
  })

  it('不存在的锚点报 ANCHOR_NOT_FOUND', () => {
    const reg = registry()
    try {
      reg.resolve('nope', 1, CONTENT)
      expect.unreachable()
    } catch (err) {
      expect((err as AnchorError).code).toBe('ANCHOR_NOT_FOUND')
    }
  })

  it('文件提交新修订后旧锚点被批量失效', () => {
    const reg = registry()
    const { anchor: a } = reg.capture('a.ts', 1, CONTENT, { startLine: 1 })
    const { anchor: b } = reg.capture('b.ts', 1, CONTENT, { startLine: 1 })
    reg.invalidatePath('a.ts', 2)
    expect(reg.get(a.id)).toBeUndefined()
    // 其他文件的锚点不受影响
    expect(reg.get(b.id)).toBeDefined()
  })

  it('registerOffsets 给 search matchId 用,同样非空校验', () => {
    const reg = registry()
    const anchor = reg.registerOffsets('a.ts', 1, CONTENT, 0, 5)
    expect(reg.resolve(anchor.id, 1, CONTENT).startOffset).toBe(0)
    expect(() => reg.registerOffsets('a.ts', 1, CONTENT, 5, 5)).toThrow(AnchorError)
    expect(() => reg.registerOffsets('a.ts', 1, CONTENT, 5, 999)).toThrow(AnchorError)
  })
})
