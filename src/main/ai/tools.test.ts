import { describe, expect, it } from 'vitest'
import { buildFileTools } from './tools'
import { SessionVfs } from './session-vfs'
import type { VfsPatch } from './session-vfs'

/**
 * 工具层的契约测试:schema 能不能过、错误是不是被转成结果文本而不是抛出、
 * patch 事件有没有按预期发出。SessionVfs 自己的行为在 session-vfs.test.ts。
 */

const SEED = [
  { path: 'index.html', content: '<h1>你好</h1>\n<p class="lead">world</p>\n' },
  { path: 'css/style.css', content: '.hero { color: red; }\n.card { color: red; }\n' }
]

interface Harness {
  vfs: SessionVfs
  patches: VfsPatch[]
  deleted: string[]
  call: (name: string, input: unknown) => Promise<string>
}

function harnessWith(seed: { path: string; content: string }[]): Harness {
  const vfs = new SessionVfs(seed)
  const patches: VfsPatch[] = []
  const deleted: string[] = []
  const tools = buildFileTools(vfs, {
    onPatch: (p) => patches.push(p),
    onDelete: (p) => deleted.push(p)
  })
  const call = async (name: string, input: unknown): Promise<string> => {
    const entry = tools[name]
    if (!entry?.execute) throw new Error(`没有工具 ${name}`)
    const out = await entry.execute(input as never, { toolCallId: 't', messages: [] } as never)
    return String(out)
  }
  return { vfs, patches, deleted, call }
}

function harness(): Harness {
  const vfs = new SessionVfs(SEED)
  const patches: VfsPatch[] = []
  const deleted: string[] = []
  const tools = buildFileTools(vfs, {
    onPatch: (p) => patches.push(p),
    onDelete: (p) => deleted.push(p)
  })

  const call = async (name: string, input: unknown): Promise<string> => {
    const entry = tools[name]
    if (!entry?.execute) throw new Error(`没有工具 ${name}`)
    // 真实调用链会先按 inputSchema 校验,这里直接喂已校验的形状
    const out = await entry.execute(
      input as never,
      {
        toolCallId: 't',
        messages: []
      } as never
    )
    return String(out)
  }

  return { vfs, patches, deleted, call }
}

describe('工具集', () => {
  it('工具名与预期一致', () => {
    const vfs = new SessionVfs(SEED)
    const names = Object.keys(buildFileTools(vfs, { onPatch: () => {}, onDelete: () => {} }))
    expect(names).toEqual([
      'list_files',
      'outline_file',
      'read_file',
      'get_range',
      'capture_range',
      'search_files',
      'apply_string_edits',
      'edit_file',
      'multi_edit_file',
      'apply_patch',
      'write_file',
      'move_file',
      'copy_file',
      'delete_file',
      'diff_changes',
      'check_syntax',
      'revert_file'
    ])
  })
})

describe('读工具', () => {
  it('list_files 带行数,支持 glob', async () => {
    const h = harness()
    expect(await h.call('list_files', {})).toBe('css/style.css\t2 行\nindex.html\t2 行')
    expect(await h.call('list_files', { glob: '*.html' })).toBe('index.html\t2 行')
    expect(await h.call('list_files', { glob: 'nope/**' })).toContain('没有匹配')
  })

  it('search_files 给出行列,可带上下文', async () => {
    const h = harness()
    expect(await h.call('search_files', { query: 'hero' })).toContain('css/style.css:1:2')

    const withContext = await h.call('search_files', { query: 'card', context_lines: 1 })
    expect(withContext).toContain('> 2  .card { color: red; }')
    expect(withContext).toContain('1  .hero { color: red; }')
  })

  it('search_files 没命中时给出下一步提示', async () => {
    expect(await harness().call('search_files', { query: '不存在' })).toContain('没有匹配')
  })

  it('get_range 取出的原文能直接当锚点用', async () => {
    const h = harness()
    const anchor = await h.call('get_range', { path: 'index.html', start_line: 2 })
    expect(anchor).toBe('<p class="lead">world</p>')

    await h.call('edit_file', {
      path: 'index.html',
      old_string: anchor,
      new_string: '<p class="lead">世界</p>'
    })
    expect(h.vfs.writes.get('index.html')).toContain('世界')
  })

  it('outline_file 给骨架', async () => {
    expect(await harness().call('outline_file', { path: 'css/style.css' })).toContain(
      '1→.hero { color: red; }'
    )
  })
})

describe('写工具', () => {
  it('edit_file 成功时发一个 patch', async () => {
    const h = harness()
    const out = await h.call('edit_file', {
      path: 'index.html',
      old_string: '<h1>你好</h1>',
      new_string: '<h1>Hello</h1>'
    })

    expect(out).toBe('已编辑 index.html')
    expect(h.patches).toEqual([
      { path: 'index.html', oldText: '<h1>你好</h1>', newText: '<h1>Hello</h1>', replaceAll: false }
    ])
  })

  it('edit_file 失败时返回错误文本而不是抛,且不发 patch', async () => {
    const h = harness()
    const out = await h.call('edit_file', {
      path: 'css/style.css',
      old_string: 'color: red',
      new_string: 'color: blue'
    })

    expect(out).toMatch(/^错误:/)
    expect(out).toContain('匹配到 2 处')
    expect(h.patches).toEqual([])
    expect(h.vfs.hasChanges).toBe(false)
  })

  it('multi_edit_file 一次多处,每处各发一个 patch', async () => {
    const h = harness()
    const out = await h.call('multi_edit_file', {
      path: 'css/style.css',
      edits: [
        { old_string: '.hero { color: red; }', new_string: '.hero { color: blue; }' },
        { old_string: '.card { color: red; }', new_string: '.card { color: green; }' }
      ]
    })

    expect(out).toContain('完成 2 处编辑')
    expect(h.patches).toHaveLength(2)
  })

  it('multi_edit_file 中途失败时整体回滚,一个 patch 都不发', async () => {
    const h = harness()
    const out = await h.call('multi_edit_file', {
      path: 'css/style.css',
      edits: [
        { old_string: '.hero { color: red; }', new_string: '.hero { color: blue; }' },
        { old_string: '压根没有', new_string: 'x' }
      ]
    })

    expect(out).toContain('第 2 处编辑失败')
    expect(h.patches).toEqual([])
    expect(h.vfs.hasChanges).toBe(false)
  })

  it('delete_file 发删除事件', async () => {
    const h = harness()
    await h.call('delete_file', { path: 'css/style.css' })
    expect(h.deleted).toEqual(['css/style.css'])
  })

  it('move_file 不需要内容参与,同时发删除与写入', async () => {
    const h = harness()
    const out = await h.call('move_file', { from: 'css/style.css', to: 'css/main.css' })

    expect(out).toContain('已把 css/style.css 移到 css/main.css')
    expect(h.deleted).toEqual(['css/style.css'])
    expect(h.vfs.writes.get('css/main.css')).toBe('.hero { color: red; }\n.card { color: red; }\n')
    expect([...h.vfs.deletes]).toEqual(['css/style.css'])
  })

  it('move_file 撞上已存在的目标时拒绝', async () => {
    const out = await harness().call('move_file', { from: 'index.html', to: 'css/style.css' })
    expect(out).toContain('已存在')
  })

  it('copy_file 留下两份', async () => {
    const h = harness()
    await h.call('copy_file', { from: 'index.html', to: 'about.html' })
    expect(h.vfs.writes.get('about.html')).toBe(h.vfs.raw('index.html').content)
    expect(h.vfs.has('index.html')).toBe(true)
  })
})

describe('revert_file', () => {
  it('改过的文件退回本回合开始的样子', async () => {
    const h = harness()
    await h.call('edit_file', {
      path: 'index.html',
      old_string: '<h1>你好</h1>',
      new_string: '<h1>坏掉了'
    })
    expect(h.vfs.hasChanges).toBe(true)

    const out = await h.call('revert_file', { path: 'index.html' })
    expect(out).toContain('已回到本回合开始时的内容')
    expect(h.vfs.hasChanges).toBe(false)
    // 撤销也要让渲染层跟着回去
    expect(h.patches.at(-1)).toEqual({
      path: 'index.html',
      oldText: '',
      newText: '<h1>你好</h1>\n<p class="lead">world</p>\n'
    })
  })

  it('本回合新建的文件撤销后不再存在', async () => {
    const h = harness()
    await h.call('write_file', { path: 'tmp.css', content: 'x\n' })

    const out = await h.call('revert_file', { path: 'tmp.css' })
    expect(out).toContain('已撤销')
    expect(h.vfs.has('tmp.css')).toBe(false)
    expect(h.vfs.hasChanges).toBe(false)
    expect(h.deleted).toEqual(['tmp.css'])
  })

  it('没改过的文件拒绝撤销', async () => {
    expect(await harness().call('revert_file', { path: 'index.html' })).toContain('没有改动过')
  })
})

describe('check_syntax', () => {
  it('结构没问题时如实说', async () => {
    const h = harness()
    await h.call('edit_file', {
      path: 'css/style.css',
      old_string: '.hero { color: red; }',
      new_string: '.hero { color: blue; }'
    })
    expect(await h.call('check_syntax', {})).toContain('结构与编译都没发现问题')
  })

  it('少一个右花括号会被指出来', async () => {
    const h = harness()
    await h.call('write_file', { path: 'bad.css', content: '.hero {\n  color: red;\n' })

    const out = await h.call('check_syntax', {})
    expect(out).toContain('bad.css:1 个问题')
    expect(out).toContain('一直没有闭合')
  })

  it('缺省时只检查本回合动过的文件', async () => {
    expect(await harness().call('check_syntax', {})).toContain('还没有改动过')
  })

  it('可以指定单个文件', async () => {
    expect(await harness().call('check_syntax', { path: 'index.html' })).toContain(
      '结构与编译都没发现问题'
    )
  })

  it('vue 文件走真编译器,语法错误当场报', async () => {
    const h = harness()
    await h.call('write_file', {
      path: 'App.vue',
      content: '<script setup lang="ts">\nconst = broken\n</script>\n<template><div>x</div></template>\n'
    })
    expect(await h.call('check_syntax', { path: 'App.vue' })).toContain('真编译失败')
  })
})

describe('写入后的编译探针', () => {
  it('写入编译不过的文件时,工具结果当轮带上编译错误', async () => {
    const h = harness()
    const out = await h.call('write_file', {
      path: 'Widget.tsx',
      content: 'export const = () => <div/>\n'
    })
    expect(out).toContain('真编译不通过')
    expect(out).toContain('Widget.tsx')
    // 改动保留:以坏版本为基线修,好过让已完成的工作蒸发
    expect(h.vfs.has('Widget.tsx')).toBe(true)
  })

  it('写入健康文件时不带编译告警', async () => {
    const h = harness()
    const out = await h.call('write_file', {
      path: 'Widget.tsx',
      content: 'export const W = () => <div>ok</div>\n'
    })
    expect(out).not.toContain('真编译不通过')
  })

  it('html 文件不走编译器', async () => {
    const h = harness()
    const out = await h.call('write_file', { path: 'x.html', content: '<div class="unclosed' })
    expect(out).not.toContain('真编译不通过')
  })
})

describe('apply_patch', () => {
  const patch = (...body: string[]): string =>
    ['*** Begin Patch', ...body, '*** End Patch'].join('\n')

  it('一次改多个文件', async () => {
    const h = harness()
    const out = await h.call('apply_patch', {
      patch: patch(
        '*** Update File: index.html',
        '@@',
        ' <h1>你好</h1>',
        '-<p class="lead">world</p>',
        '+<p class="lead">世界</p>',
        '*** Add File: css/theme.css',
        '+:root { --brand: #1677ff; }',
        '*** Delete File: css/style.css'
      )
    })

    expect(out).toContain('更新 index.html(1 处)')
    expect(out).toContain('新建 css/theme.css')
    expect(out).toContain('删除 css/style.css')

    expect(h.vfs.writes.get('index.html')).toBe('<h1>你好</h1>\n<p class="lead">世界</p>\n')
    expect(h.vfs.writes.get('css/theme.css')).toBe(':root { --brand: #1677ff; }\n')
    expect([...h.vfs.deletes]).toEqual(['css/style.css'])
    expect(h.patches).toHaveLength(2)
    expect(h.deleted).toEqual(['css/style.css'])
  })

  it('后一个文件失败时,前一个文件的改动一并回滚且不发事件', async () => {
    const h = harness()
    const out = await h.call('apply_patch', {
      patch: patch(
        '*** Update File: index.html',
        '@@',
        ' <h1>你好</h1>',
        '-<p class="lead">world</p>',
        '+<p class="lead">世界</p>',
        '*** Update File: css/style.css',
        '@@',
        ' 这一行原文里根本没有',
        '-.hero { color: red; }',
        '+.hero { color: blue; }'
      )
    })

    expect(out).toMatch(/^错误:/)
    expect(h.vfs.hasChanges).toBe(false)
    expect(h.patches).toEqual([])
    expect(h.deleted).toEqual([])
  })

  it('Add File 撞上已存在的文件时给出指引', async () => {
    const out = await harness().call('apply_patch', {
      patch: patch('*** Add File: index.html', '+x')
    })
    expect(out).toContain('已存在')
  })

  it('格式错误返回可读提示', async () => {
    expect(await harness().call('apply_patch', { patch: '随便写点什么' })).toContain('Begin Patch')
  })
})

describe('diff_changes', () => {
  it('没改动时如实说', async () => {
    expect(await harness().call('diff_changes', {})).toBe('本回合还没有任何改动。')
  })

  it('改完能看到 diff', async () => {
    const h = harness()
    await h.call('edit_file', {
      path: 'index.html',
      old_string: '<h1>你好</h1>',
      new_string: '<h1>Hello</h1>'
    })

    const out = await h.call('diff_changes', {})
    expect(out).toContain('--- index.html')
    expect(out).toContain('-<h1>你好</h1>')
    expect(out).toContain('+<h1>Hello</h1>')
  })

  it('新建与删除分别标注', async () => {
    const h = harness()
    await h.call('write_file', { path: 'new.css', content: 'x\n' })
    await h.call('delete_file', { path: 'css/style.css' })

    const out = await h.call('diff_changes', {})
    expect(out).toContain('(新建文件)')
    expect(out).toContain('(整份删除)')
  })
})

describe('锚点工具与恢复规则', () => {
  it('search_files 每个命中带 matchId,截断预览标记不可作锚点', async () => {
    const long = `.long { padding: ${'1px '.repeat(400)}}`
    const h = harnessWith([{ path: 'a.css', content: `${long}\n.hero { color: red; }\n` }])
    const out = await h.call('search_files', { query: 'padding' })
    expect(out).toContain('[matchId: ')
    expect(out).toContain('不可')
  })

  it('capture_range 返回精确不截断原文与 anchorId', async () => {
    const long = `x${'y'.repeat(1200)}z`
    const h = harnessWith([{ path: 'a.css', content: `${long}\nshort\n` }])
    const out = await h.call('capture_range', { path: 'a.css', start_line: 1 })
    expect(out).toContain('anchorId: ')
    expect(out).toContain(long)
  })

  it('apply_string_edits 按锚点原子提交并发 patch 事件', async () => {
    const h = harness()
    const captured = await h.call('capture_range', { path: 'index.html', start_line: 2 })
    const anchorId = /anchorId: (\S+)/.exec(captured)![1]
    const out = await h.call('apply_string_edits', {
      operations: [{ type: 'replace', anchor_id: anchorId, content: '<p>世界</p>' }]
    })
    expect(out).toContain('已按锚点完成编辑')
    expect(h.vfs.raw('index.html').content).toContain('<p>世界</p>')
    expect(h.patches.some((p) => p.path === 'index.html')).toBe(true)
  })

  it('过期锚点报 ANCHOR_STALE 且不产生副作用', async () => {
    const h = harness()
    const captured = await h.call('capture_range', { path: 'index.html', start_line: 2 })
    const anchorId = /anchorId: (\S+)/.exec(captured)![1]
    await h.call('edit_file', {
      path: 'index.html',
      old_string: '<h1>你好</h1>',
      new_string: '<h1>标题</h1>'
    })
    const out = await h.call('apply_string_edits', {
      operations: [{ type: 'remove', anchor_id: anchorId }]
    })
    expect(out).toContain('[code: ANCHOR_STALE]')
    expect(h.vfs.raw('index.html').content).toContain('world')
  })

  it('首次补丁失配的错误带切换锚点编辑的恢复建议', async () => {
    const h = harness()
    const out = await h.call('edit_file', {
      path: 'index.html',
      old_string: '不存在的原文',
      new_string: 'x'
    })
    expect(out).toContain('[code: MATCH_NOT_FOUND]')
    expect(out).toContain('capture_range')
  })

  it('同文件同错误第二次后禁用文本补丁', async () => {
    const h = harness()
    await h.call('edit_file', { path: 'index.html', old_string: '错1', new_string: 'x' })
    await h.call('edit_file', { path: 'index.html', old_string: '错2', new_string: 'x' })
    // 第三次哪怕锚点是对的,也直接拒绝并要求锚点编辑
    const out = await h.call('edit_file', {
      path: 'index.html',
      old_string: '<h1>你好</h1>',
      new_string: '<h1>标题</h1>'
    })
    expect(out).toContain('不再接受文本补丁')
    expect(out).toContain('apply_string_edits')
  })

  it('连续三次写失败后暂停写入,读取后解除', async () => {
    const h = harness()
    await h.call('edit_file', { path: 'index.html', old_string: '错1', new_string: 'x' })
    await h.call('edit_file', { path: 'css/style.css', old_string: '错2', new_string: 'x' })
    await h.call('write_file', { path: '../bad', content: 'x' })
    const blocked = await h.call('write_file', { path: 'ok.css', content: 'p{}' })
    expect(blocked).toContain('已暂停写入')
    await h.call('read_file', { path: 'index.html' })
    const after = await h.call('write_file', { path: 'ok.css', content: 'p{}' })
    expect(after).toContain('已写入')
  })

  it('相同工具/目标/参数指纹不得执行两次', async () => {
    const h = harness()
    const first = await h.call('read_file', { path: 'index.html' })
    expect(first).toContain('你好')
    const second = await h.call('read_file', { path: 'index.html' })
    expect(second).toContain('重复调用')
    // 文件变了以后可以重读
    await h.call('edit_file', {
      path: 'index.html',
      old_string: '<h1>你好</h1>',
      new_string: '<h1>标题</h1>'
    })
    const third = await h.call('read_file', { path: 'index.html' })
    expect(third).toContain('标题')
  })

  it('check_syntax 对超长行给可编辑性警告但不阻止', async () => {
    const h = harnessWith([{ path: 'a.css', content: `.x{${'a:1;'.repeat(300)}}\n` }])
    await h.call('write_file', { path: 'a.css', content: `.x{${'a:1;'.repeat(300)}}\n.y{}\n` })
    const out = await h.call('check_syntax', {})
    expect(out).toContain('可编辑性警告')
    expect(out).toContain('capture_range')
  })
})
