import { describe, expect, it } from 'vitest'
import { labelFor, summarize, verbOf } from './tool-activity'

/**
 * 标签的两个硬要求:
 * 1. **入参只到一半也要能出话** —— 模型逐字吐入参,path 通常最先到,
 *    早一秒告诉用户在写哪个文件,体验差别很大。
 * 2. **绝不把大字段抖出来** —— write_file 的 content 是整份文件,
 *    apply_patch 的 patch 是整个补丁,标签里一个字都不能带。
 */

describe('入参不全时', () => {
  it('什么都没有就给通用动词', () => {
    expect(labelFor('read_file', undefined)).toBe('读取')
    expect(labelFor('search_files', {})).toBe('搜索')
  })

  it('只解析出 path 就先用 path', () => {
    expect(labelFor('read_file', { path: 'index.html' })).toBe('读取 index.html')
  })

  it('行号到齐了再补上', () => {
    expect(labelFor('read_file', { path: 'a.css', start_line: 10 })).toBe('读取 a.css 第 10 行起')
    expect(labelFor('read_file', { path: 'a.css', start_line: 10, end_line: 40 })).toBe(
      '读取 a.css 10-40 行'
    )
  })

  it('半截字符串不当数据用', () => {
    // JSON 解析到一半时 path 可能还是空串
    expect(labelFor('write_file', { path: '' })).toBe('写入')
  })
})

describe('大字段不外泄', () => {
  it('write_file 的标签里没有文件内容', () => {
    const content = '<h1>机密</h1>\n'.repeat(500)
    const label = labelFor('write_file', { path: 'index.html', content })
    expect(label).toBe('写入 index.html')
    expect(label).not.toContain('机密')
  })

  it('apply_patch 只数文件个数', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.css',
      '@@',
      ' .x {',
      '-  color: red;',
      '+  color: blue;',
      ' }',
      '*** Add File: b.css',
      '+.y {}',
      '*** End Patch'
    ].join('\n')
    const label = labelFor('apply_patch', { patch })
    expect(label).toBe('应用补丁(2 个文件)')
    expect(label).not.toContain('color')
  })

  it('multi_edit_file 只数处数', () => {
    expect(
      labelFor('multi_edit_file', {
        path: 'a.css',
        edits: [
          { old_string: 'x', new_string: 'y' },
          { old_string: 'p', new_string: 'q' }
        ]
      })
    ).toBe('批量编辑 a.css(2 处)')
  })
})

describe('各工具的标签', () => {
  it('搜索带上关键词与范围', () => {
    expect(labelFor('search_files', { query: '--brand' })).toBe('搜索 “--brand”')
    expect(labelFor('search_files', { query: 'hero', glob: 'css/**' })).toBe('搜索 “hero” (css/**)')
  })

  it('移动与复制显示两端', () => {
    expect(labelFor('move_file', { from: 'a.css', to: 'css/a.css' })).toBe('移动 a.css → css/a.css')
    expect(labelFor('copy_file', { from: 'a.html' })).toBe('复制 a.html')
  })

  it('check_syntax 不带 path 时说明范围', () => {
    expect(labelFor('check_syntax', {})).toBe('结构自检(本轮改动)')
    expect(labelFor('check_syntax', { path: 'a.css' })).toBe('结构自检 a.css')
  })

  it('没登记过的工具退回工具名', () => {
    expect(verbOf('unknown_tool')).toBe('unknown_tool')
    expect(labelFor('unknown_tool', { path: 'x' })).toBe('unknown_tool x')
  })
})

describe('结果摘要', () => {
  it('错误结果标成失败', () => {
    const out = summarize('edit_file', '错误:未找到匹配内容。请先 search_files 确认原文')
    expect(out.ok).toBe(false)
    expect(out.summary).toContain('未找到匹配内容')
  })

  it('搜索给命中数', () => {
    expect(summarize('search_files', '3 处匹配:\n\na.css:1:2: x')).toEqual({
      ok: true,
      summary: '3 处匹配'
    })
    expect(summarize('search_files', '没有匹配。可以放宽关键词').summary).toBe('没有匹配')
  })

  it('读类给行数', () => {
    expect(summarize('read_file', '1→a\n2→b\n3→c').summary).toBe('3 行')
  })

  it('自检给结论', () => {
    expect(summarize('check_syntax', 'a.css:没发现结构问题').summary).toBe('没问题')
    expect(summarize('check_syntax', 'a.css:1 个问题\n  1:1 缺一个 }').summary).toBe('发现问题')
  })

  /*
   * 「动词 + 单个路径」不给摘要:标签里已经是「写入 components/X.vue」,
   * 摘要再来一遍「已写入 components/X.vue」,同一个路径一行出现两次。
   * 成功由行首的 ✓ 表示,不需要文字复述。
   */
  it('写类结果不复述路径——标签里已经有了', () => {
    expect(summarize('write_file', '已写入 components/DesignSystem.vue').summary).toBeUndefined()
    expect(summarize('edit_file', '已编辑 index.html').summary).toBeUndefined()
    expect(summarize('delete_file', '已删除 old.css').summary).toBeUndefined()
  })

  it('但带额外信息的照常保留', () => {
    // 「3 处」是标签里没有的新信息,不能连它一起吞掉
    expect(summarize('multi_edit', '已编辑 3 处').summary).toBe('已编辑 3 处')
  })

  it('成功仍然是成功,只是不给文字', () => {
    expect(summarize('write_file', '已写入 a.vue').ok).toBe(true)
  })

  it('过长的结果不做摘要,免得把正文抖出来', () => {
    expect(summarize('write_file', 'x'.repeat(200)).summary).toBeUndefined()
  })

  it('结构化结果(view_image)不摘要', () => {
    expect(summarize('view_image', { type: 'content', value: [] })).toEqual({ ok: true })
  })
})
