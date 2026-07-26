import { describe, expect, it } from 'vitest'
import { AnchorRegistry } from './anchor-registry'
import { SessionVfs, VfsError } from './session-vfs'
import { MagicStringBatchEditor, StringEditError } from './string-edits'
import type { StringEditOperation } from './string-edits'

/**
 * 原子批量编辑:所有操作按**原始坐标**合成,先算全所有文件的产物,
 * 再一次性提交 VFS。任何失败都不留下半成品。
 */

function setup(files: Record<string, string>): {
  vfs: SessionVfs
  registry: AnchorRegistry
  editor: MagicStringBatchEditor
  capture: (path: string, startLine: number, opts?: Record<string, unknown>) => string
} {
  const vfs = new SessionVfs(Object.entries(files).map(([path, content]) => ({ path, content })))
  const registry = new AnchorRegistry()
  const editor = new MagicStringBatchEditor(vfs, registry)
  const capture = (path: string, startLine: number, opts: Record<string, unknown> = {}): string =>
    registry.capture(path, vfs.revisionOf(path)!, vfs.raw(path).content, {
      startLine,
      ...opts
    }).anchor.id
  return { vfs, registry, editor, capture }
}

const BASE = ['line one', 'line two', 'line three'].join('\n')

describe('四种操作', () => {
  it('replace / remove / insert_before / insert_after', () => {
    const { vfs, editor, capture } = setup({ 'a.txt': BASE })
    // 同一段的 before/after 复用同一个锚点——两个同区间锚点会被判重叠
    const third = capture('a.txt', 3)
    const ops: StringEditOperation[] = [
      { type: 'replace', anchorId: capture('a.txt', 1), content: 'ONE' },
      { type: 'remove', anchorId: capture('a.txt', 2, { includeTrailingNewline: true }) },
      { type: 'insert_before', anchorId: third, content: '>>' },
      { type: 'insert_after', anchorId: third, content: '<<' }
    ]
    editor.apply(ops)
    expect(vfs.raw('a.txt').content).toBe('ONE\n>>line three<<')
  })

  it('同一锚点多个 before/after 按请求数组顺序拼接', () => {
    const { vfs, editor, capture } = setup({ 'a.txt': 'core' })
    const id = capture('a.txt', 1)
    editor.apply([
      { type: 'insert_before', anchorId: id, content: 'b1-' },
      { type: 'insert_after', anchorId: id, content: '-a1' },
      { type: 'insert_before', anchorId: id, content: 'b2-' },
      { type: 'insert_after', anchorId: id, content: '-a2' }
    ])
    expect(vfs.raw('a.txt').content).toBe('b1-b2-core-a1-a2')
  })

  it('before + replace + after 组合成一次 update', () => {
    const { vfs, editor, capture } = setup({ 'a.txt': 'core' })
    const id = capture('a.txt', 1)
    editor.apply([
      { type: 'insert_before', anchorId: id, content: '[' },
      { type: 'replace', anchorId: id, content: 'CORE' },
      { type: 'insert_after', anchorId: id, content: ']' }
    ])
    expect(vfs.raw('a.txt').content).toBe('[CORE]')
  })

  it('只有 insert 时锚点原文保留', () => {
    const { vfs, editor, capture } = setup({ 'a.txt': 'core' })
    editor.apply([{ type: 'insert_before', anchorId: capture('a.txt', 1), content: 'x-' }])
    expect(vfs.raw('a.txt').content).toBe('x-core')
  })
})

describe('冲突与校验', () => {
  it('同一锚点最多一个 replace/remove', () => {
    const { editor, capture } = setup({ 'a.txt': BASE })
    const id = capture('a.txt', 1)
    expect(() =>
      editor.apply([
        { type: 'replace', anchorId: id, content: 'x' },
        { type: 'remove', anchorId: id }
      ])
    ).toThrow(StringEditError)
  })

  it('相邻(共享边界)允许,部分重叠拒绝', () => {
    const { vfs, editor, registry } = setup({ 'a.txt': 'abcdef' })
    const content = vfs.raw('a.txt').content
    const left = registry.registerOffsets('a.txt', 1, content, 0, 3)
    const right = registry.registerOffsets('a.txt', 1, content, 3, 6)
    editor.apply([
      { type: 'replace', anchorId: left.id, content: 'ABC' },
      { type: 'replace', anchorId: right.id, content: 'DEF' }
    ])
    expect(vfs.raw('a.txt').content).toBe('ABCDEF')

    const c2 = vfs.raw('a.txt').content
    const rev = vfs.revisionOf('a.txt')!
    const o1 = registry.registerOffsets('a.txt', rev, c2, 0, 4)
    const o2 = registry.registerOffsets('a.txt', rev, c2, 2, 6)
    expect(() =>
      editor.apply([
        { type: 'replace', anchorId: o1.id, content: 'x' },
        { type: 'remove', anchorId: o2.id }
      ])
    ).toThrow(StringEditError)
    // 整批拒绝:内容一个字都没动
    expect(vfs.raw('a.txt').content).toBe('ABCDEF')
  })

  it('完全包含也算重叠', () => {
    const { editor, registry, vfs } = setup({ 'a.txt': 'abcdef' })
    const content = vfs.raw('a.txt').content
    const outer = registry.registerOffsets('a.txt', 1, content, 0, 6)
    const inner = registry.registerOffsets('a.txt', 1, content, 2, 4)
    expect(() =>
      editor.apply([
        { type: 'remove', anchorId: outer.id },
        { type: 'replace', anchorId: inner.id, content: 'x' }
      ])
    ).toThrow(StringEditError)
  })

  it('操作顺序不影响结果(全部按原始坐标)', () => {
    const run = (shuffle: boolean): string => {
      const { vfs, editor, capture } = setup({ 'a.txt': BASE })
      const ops: StringEditOperation[] = [
        { type: 'replace', anchorId: capture('a.txt', 1), content: 'FIRST' },
        { type: 'replace', anchorId: capture('a.txt', 3), content: 'THIRD' },
        { type: 'replace', anchorId: capture('a.txt', 2), content: 'SECOND' }
      ]
      editor.apply(shuffle ? [...ops].reverse() : ops)
      return vfs.raw('a.txt').content
    }
    expect(run(false)).toBe('FIRST\nSECOND\nTHIRD')
    expect(run(true)).toBe('FIRST\nSECOND\nTHIRD')
  })

  it('过期锚点(revision 变化)整批拒绝', () => {
    const { vfs, editor, capture } = setup({ 'a.txt': BASE, 'b.txt': 'hello' })
    const stale = capture('a.txt', 1)
    vfs.edit('a.txt', 'line two', 'line 2')
    const fresh = capture('b.txt', 1)
    expect(() =>
      editor.apply([
        { type: 'replace', anchorId: fresh, content: 'HELLO' },
        { type: 'replace', anchorId: stale, content: 'x' }
      ])
    ).toThrow()
    // b.txt 也不能动:整批原子
    expect(vfs.raw('b.txt').content).toBe('hello')
  })
})

describe('多文件原子性', () => {
  it('跨文件一次提交,修订号各自 +1', () => {
    const { vfs, editor, capture } = setup({ 'a.txt': BASE, 'b.txt': 'hello world' })
    editor.apply([
      { type: 'replace', anchorId: capture('a.txt', 2), content: 'L2' },
      { type: 'replace', anchorId: capture('b.txt', 1), content: 'HELLO' }
    ])
    expect(vfs.raw('a.txt').content).toBe('line one\nL2\nline three')
    expect(vfs.raw('b.txt').content).toBe('HELLO')
    expect(vfs.revisionOf('a.txt')).toBe(2)
    expect(vfs.revisionOf('b.txt')).toBe(2)
  })

  it('写入被闸门拒绝时全部回滚,修订号不动', () => {
    const { vfs, editor, capture } = setup({ 'a.txt': BASE, 'b.txt': 'hello' })
    const ops: StringEditOperation[] = [
      { type: 'replace', anchorId: capture('a.txt', 1), content: 'x' },
      { type: 'replace', anchorId: capture('b.txt', 1), content: 'y' }
    ]
    vfs.blockWrites('先确认视觉方向')
    expect(() => editor.apply(ops)).toThrow(VfsError)
    expect(vfs.raw('a.txt').content).toBe(BASE)
    expect(vfs.revisionOf('a.txt')).toBe(1)
  })

  it('提交成功后旧锚点批量失效', () => {
    const { vfs, editor, registry, capture } = setup({ 'a.txt': BASE })
    const used = capture('a.txt', 1)
    const bystander = capture('a.txt', 3)
    editor.apply([{ type: 'replace', anchorId: used, content: 'ONE' }])
    expect(registry.get(used)).toBeUndefined()
    expect(registry.get(bystander)).toBeUndefined()
    expect(vfs.revisionOf('a.txt')).toBe(2)
  })
})

describe('极端内容', () => {
  it('800–1700 字符超长行可靠替换', () => {
    const long = 'x'.repeat(1500)
    const content = `const options = [${long}]\nnext line`
    const { vfs, editor, registry } = setup({ 'a.ts': content })
    const anchor = registry.registerOffsets('a.ts', 1, content, 17, 17 + 1500)
    editor.apply([{ type: 'replace', anchorId: anchor.id, content: 'SHORT' }])
    expect(vfs.raw('a.ts').content).toBe('const options = [SHORT]\nnext line')
  })

  it('emoji 与中文不被切坏', () => {
    const content = '标题 😀🎉 结束'
    const { vfs, editor, registry } = setup({ 'a.txt': content })
    // 😀 从偏移 3 开始占 2 个 code unit
    const anchor = registry.registerOffsets('a.txt', 1, content, 3, 5)
    editor.apply([{ type: 'replace', anchorId: anchor.id, content: '😎' }])
    expect(vfs.raw('a.txt').content).toBe('标题 😎🎉 结束')
  })

  it('CRLF 文件替换整行不弄丢 \\r', () => {
    const content = 'first\r\nsecond\r\nthird\r\n'
    const { vfs, editor, capture } = setup({ 'a.txt': content })
    editor.apply([{ type: 'replace', anchorId: capture('a.txt', 2), content: 'SECOND' }])
    expect(vfs.raw('a.txt').content).toBe('first\r\nSECOND\r\nthird\r\n')
  })

  it('整行删除:include_trailing_newline + remove', () => {
    const { vfs, editor, capture } = setup({ 'a.txt': 'one\ntwo\nthree\n' })
    editor.apply([
      { type: 'remove', anchorId: capture('a.txt', 2, { includeTrailingNewline: true }) }
    ])
    expect(vfs.raw('a.txt').content).toBe('one\nthree\n')
  })
})
