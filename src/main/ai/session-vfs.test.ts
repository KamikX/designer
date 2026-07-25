import { describe, expect, it } from 'vitest'
import { MAX_READ_LINES, SessionVfs, VfsError, globToRegExp } from './session-vfs'
import { FileStreamParser } from './file-stream-parser'
import { parsePatch } from './patch-format'
import { unifiedDiff } from './text-diff'
import { outlineOf } from './text-outline'

const SEED = [
  { path: 'index.html', content: '<h1>你好</h1>\n<p>world</p>\n' },
  { path: 'css/style.css', content: 'h1 { color: red; }\np { color: red; }\n' }
]

const vfs = (): SessionVfs => new SessionVfs(SEED)

describe('SessionVfs.edit', () => {
  it('唯一命中时就地替换,writes 只含被改过的文件', () => {
    const fs = vfs()
    const patch = fs.edit('index.html', '<h1>你好</h1>', '<h1>Hello</h1>')

    expect(patch).toEqual({
      path: 'index.html',
      oldText: '<h1>你好</h1>',
      newText: '<h1>Hello</h1>',
      replaceAll: false
    })
    expect(fs.writes.get('index.html')).toBe('<h1>Hello</h1>\n<p>world</p>\n')
    expect([...fs.writes.keys()]).toEqual(['index.html'])
    expect(fs.deletes.size).toBe(0)
  })

  it('未命中时报错说清怎么办,且不改动文件', () => {
    const fs = vfs()
    expect(() => fs.edit('index.html', '<h1>Hi</h1>', 'x')).toThrow(VfsError)
    expect(() => fs.edit('index.html', '<h1>Hi</h1>', 'x')).toThrow(/未找到匹配内容/)
    expect(fs.hasChanges).toBe(false)
  })

  it('命中多处时拒绝,提示扩大锚点或 replace_all', () => {
    const fs = vfs()
    expect(() => fs.edit('css/style.css', 'color: red', 'color: blue')).toThrow(/匹配到 2 处/)
    expect(fs.hasChanges).toBe(false)
  })

  it('replace_all 时多处一起替换', () => {
    const fs = vfs()
    const patch = fs.edit('css/style.css', 'color: red', 'color: blue', true)

    expect(patch.replaceAll).toBe(true)
    expect(fs.writes.get('css/style.css')).toBe('h1 { color: blue; }\np { color: blue; }\n')
  })

  it('替换串里的 $& 按字面处理,不当正则展开', () => {
    const fs = vfs()
    fs.edit('index.html', '<p>world</p>', '<p>$& $1</p>')
    expect(fs.writes.get('index.html')).toBe('<h1>你好</h1>\n<p>$& $1</p>\n')
  })

  it('文件不存在时指向 write_file', () => {
    expect(() => vfs().edit('missing.css', 'a', 'b')).toThrow(/新建文件请用 write_file/)
  })

  it('新旧内容相同时拒绝', () => {
    expect(() => vfs().edit('index.html', '<p>world</p>', '<p>world</p>')).toThrow(/新旧内容相同/)
  })

  it('old_string 为空时指向 write_file', () => {
    expect(() => vfs().edit('index.html', '', 'x')).toThrow(/整份写入请用 write_file/)
  })
})

describe('SessionVfs.multiEdit', () => {
  it('按顺序施加多处编辑,每处各出一个 patch', () => {
    const fs = vfs()
    const patches = fs.multiEdit('css/style.css', [
      { oldText: 'h1 { color: red; }', newText: 'h1 { color: blue; }' },
      { oldText: 'p { color: red; }', newText: 'p { color: green; }' }
    ])

    expect(patches).toHaveLength(2)
    expect(fs.writes.get('css/style.css')).toBe('h1 { color: blue; }\np { color: green; }\n')
  })

  it('后一处编辑可以命中前一处的产物', () => {
    const fs = vfs()
    fs.multiEdit('index.html', [
      { oldText: '<h1>你好</h1>', newText: '<h1 class="t">你好</h1>' },
      { oldText: '<h1 class="t">你好</h1>', newText: '<h1 class="title">你好</h1>' }
    ])
    expect(fs.writes.get('index.html')).toBe('<h1 class="title">你好</h1>\n<p>world</p>\n')
  })

  it('任何一处失败就整体回滚,并报出是第几处', () => {
    const fs = vfs()
    expect(() =>
      fs.multiEdit('css/style.css', [
        { oldText: 'h1 { color: red; }', newText: 'h1 { color: blue; }' },
        { oldText: '不存在的内容', newText: 'x' }
      ])
    ).toThrow(/第 2 处编辑失败/)
    expect(fs.hasChanges).toBe(false)
  })
})

describe('SessionVfs 路径校验', () => {
  for (const bad of ['../secret.env', 'a/../../b.css', '/etc/passwd', 'C:/win.ini', '  ']) {
    it(`拦截 ${JSON.stringify(bad)}`, () => {
      expect(() => vfs().write(bad, 'x')).toThrow(VfsError)
    })
  }

  it('反斜杠归一成正斜杠', () => {
    const fs = vfs()
    expect(fs.write('css\\theme.css', 'x').path).toBe('css/theme.css')
    expect([...fs.writes.keys()]).toEqual(['css/theme.css'])
  })
})

describe('SessionVfs.read', () => {
  it('带行号返回', () => {
    expect(vfs().read('index.html')).toBe('1→<h1>你好</h1>\n2→<p>world</p>')
  })

  it('按行区间读取(闭区间)', () => {
    const fs = new SessionVfs([{ path: 'a.txt', content: 'a\nb\nc\nd\n' }])
    const out = fs.read('a.txt', 2, 3)
    expect(out).toContain('2→b\n3→c')
    expect(out).toContain('共 4 行,当前只看了 2-3')
  })

  it('不带区间时超过上限就截断,并说明截到哪', () => {
    const many = Array.from({ length: MAX_READ_LINES + 50 }, (_, i) => `line ${i + 1}`).join('\n')
    const fs = new SessionVfs([{ path: 'big.md', content: `${many}\n` }])
    const out = fs.read('big.md')

    expect(out).toContain(`${MAX_READ_LINES}→line ${MAX_READ_LINES}`)
    expect(out).not.toContain(`line ${MAX_READ_LINES + 1}`)
    expect(out).toContain(`单次最多读 ${MAX_READ_LINES} 行`)
  })

  it('区间之外的部分补一份结构大纲', () => {
    const content = ['# 标题一', '正文', '正文', '# 标题二', '正文'].join('\n')
    const fs = new SessionVfs([{ path: 'doc.md', content }])
    const out = fs.read('doc.md', 1, 2)

    expect(out).toContain('区间之外的结构大纲')
    expect(out).toContain('4→# 标题二')
    expect(out).not.toContain('1→# 标题一\n\n') // 区间内的不重复出现在大纲里
  })

  it('超长单行会被截断', () => {
    const fs = new SessionVfs([{ path: 'min.css', content: `${'a'.repeat(2000)}\n` }])
    expect(fs.read('min.css')).toContain('本行还有')
  })

  it('文件不存在时报错', () => {
    expect(() => vfs().read('nope.html')).toThrow(/文件不存在/)
  })
})

describe('SessionVfs.getRange', () => {
  const fs = (): SessionVfs =>
    new SessionVfs([{ path: 'a.css', content: '.hero {\n  color: red;\n}\n' }])

  it('取整行时不带行号,可直接当锚点', () => {
    expect(fs().getRange('a.css', 2)).toBe('  color: red;')
  })

  it('取多行', () => {
    expect(fs().getRange('a.css', 1, 3)).toBe('.hero {\n  color: red;\n}')
  })

  it('按列切片', () => {
    expect(fs().getRange('a.css', 2, 2, 3, 14)).toBe('color: red;')
  })

  it('越界报错', () => {
    expect(() => fs().getRange('a.css', 99)).toThrow(/超出文件范围/)
  })
})

describe('SessionVfs.search', () => {
  const big = (): SessionVfs =>
    new SessionVfs([
      { path: 'index.html', content: '<div class="hero">\n<span>hi</span>\n</div>\n' },
      { path: 'css/style.css', content: '.hero { color: red; }\n.card { color: red; }\n' }
    ])

  it('返回路径、行、列,按路径序', () => {
    const hits = big().search('hero')
    expect(hits.map((h) => `${h.path}:${h.line}:${h.column}`)).toEqual([
      'css/style.css:1:2', // .hero 的 h 在第 2 列
      'index.html:1:13'
    ])
  })

  it('glob 限定搜索范围', () => {
    expect(
      big()
        .search('hero', { glob: 'css/**' })
        .map((h) => h.path)
    ).toEqual(['css/style.css'])
  })

  it('带上下文行', () => {
    const [hit] = big().search('span', { contextLines: 1 })
    expect(hit.before).toEqual(['<div class="hero">'])
    expect(hit.after).toEqual(['</div>'])
  })

  it('默认不区分大小写,可以打开', () => {
    expect(big().search('HERO')).toHaveLength(2)
    expect(big().search('HERO', { caseSensitive: true })).toHaveLength(0)
  })

  it('正则模式', () => {
    expect(big().search('color:\\s*red', { regex: true })).toHaveLength(2)
  })

  it('非法正则给出可读错误', () => {
    expect(() => big().search('[', { regex: true })).toThrow(/正则表达式无效/)
  })

  it('maxResults 截断', () => {
    expect(big().search('color', { maxResults: 1 })).toHaveLength(1)
  })
})

describe('glob', () => {
  const cases: [string, string, boolean][] = [
    ['*.html', 'index.html', true],
    ['*.html', 'css/index.html', false],
    ['css/**', 'css/a/b.css', true],
    ['**/*.css', 'style.css', true],
    ['**/*.css', 'css/deep/style.css', true],
    ['**/*.css', 'style.js', false],
    ['a?.js', 'a1.js', true],
    ['a?.js', 'a12.js', false]
  ]
  for (const [glob, path, expected] of cases) {
    it(`${glob} ${expected ? '匹配' : '不匹配'} ${path}`, () => {
      expect(globToRegExp(glob).test(path)).toBe(expected)
    })
  }
})

describe('SessionVfs.stats / list', () => {
  it('列表带行数', () => {
    expect(vfs().stats()).toEqual([
      { path: 'css/style.css', lines: 2, chars: 37 },
      { path: 'index.html', lines: 2, chars: 25 }
    ])
  })
})

describe('SessionVfs.write / remove', () => {
  it('write 的 patch 用空 oldText 表示整份替换', () => {
    expect(vfs().write('index.html', 'new').oldText).toBe('')
  })

  it('先写后删的文件只出现在 deletes 里', () => {
    const fs = vfs()
    fs.write('tmp.css', 'x')
    fs.remove('tmp.css')
    expect([...fs.writes.keys()]).toEqual([])
    expect([...fs.deletes]).toEqual(['tmp.css'])
  })

  it('先删后写的文件只出现在 writes 里', () => {
    const fs = vfs()
    fs.remove('index.html')
    fs.write('index.html', 'back')
    expect(fs.writes.get('index.html')).toBe('back')
    expect(fs.deletes.size).toBe(0)
  })

  it('删不存在的文件报错', () => {
    expect(() => vfs().remove('nope.css')).toThrow(/无需删除/)
  })
})

describe('SessionVfs.transact', () => {
  it('中途抛错时文件与改动集一起回滚', () => {
    const fs = vfs()
    expect(() =>
      fs.transact(() => {
        fs.write('new.css', 'x')
        fs.edit('index.html', '<h1>你好</h1>', '<h1>Hello</h1>')
        throw new VfsError('第三个文件失败了')
      })
    ).toThrow(/第三个文件失败了/)

    expect(fs.hasChanges).toBe(false)
    expect(fs.has('new.css')).toBe(false)
    expect(fs.read('index.html')).toContain('<h1>你好</h1>')
  })

  it('跑通时照常生效', () => {
    const fs = vfs()
    fs.transact(() => fs.write('new.css', 'x'))
    expect([...fs.writes.keys()]).toEqual(['new.css'])
  })
})

describe('SessionVfs.changes', () => {
  it('相对回合开始时的快照,给出改前改后', () => {
    const fs = vfs()
    fs.edit('index.html', '<h1>你好</h1>', '<h1>Hello</h1>')
    fs.remove('css/style.css')

    expect(fs.changes()).toEqual([
      {
        path: 'index.html',
        before: '<h1>你好</h1>\n<p>world</p>\n',
        after: '<h1>Hello</h1>\n<p>world</p>\n'
      },
      { path: 'css/style.css', before: 'h1 { color: red; }\np { color: red; }\n', after: null }
    ])
  })

  it('新建文件的 before 为空', () => {
    const fs = vfs()
    fs.write('new.css', 'x\n')
    expect(fs.changes()[0]).toEqual({ path: 'new.css', before: '', after: 'x\n' })
  })
})

describe('两条协议灌进 VFS 后产出等价', () => {
  const MARKERS = [
    '把标题改成 Hello。',
    '<antdFile path="index.html">',
    '<h1>Hello</h1>',
    '<p>world</p>',
    '</antdFile>',
    '<antdDelete path="css/style.css" />',
    '好了。'
  ].join('\n')

  it('markers 路与 tools 路的 writes / deletes 一致', () => {
    const parser = new FileStreamParser()
    parser.push(MARKERS)
    parser.finish()
    const fromMarkers = vfs()
    fromMarkers.ingest(parser.files, parser.deleted)

    const fromTools = vfs()
    fromTools.edit('index.html', '<h1>你好</h1>', '<h1>Hello</h1>')
    fromTools.remove('css/style.css')

    expect([...fromTools.writes]).toEqual([...fromMarkers.writes])
    expect([...fromTools.deletes]).toEqual([...fromMarkers.deletes])
    expect(fromTools.hasChanges).toBe(true)
  })

  it('ingest 丢弃非法路径而不是抛,一个坏路径不拖垮整回合', () => {
    const fs = vfs()
    fs.ingest(
      new Map([
        ['../evil.css', 'x'],
        ['ok.css', 'y']
      ]),
      new Set(['/etc/passwd'])
    )
    expect([...fs.writes.keys()]).toEqual(['ok.css'])
    expect(fs.deletes.size).toBe(0)
  })

  it('没有任何改动时 hasChanges 为 false', () => {
    const fs = vfs()
    fs.read('index.html')
    fs.list()
    expect(fs.hasChanges).toBe(false)
  })
})

describe('outlineOf', () => {
  it('html 取块级标签与带 id 的标签', () => {
    const lines = [
      '<!doctype html>',
      '<body>',
      '  <section class="hero">',
      '    <span>不进大纲</span>',
      '    <p id="tip">进大纲</p>',
      '  </section>',
      '</body>'
    ]
    expect(outlineOf('index.html', lines).map((e) => e.line)).toEqual([1, 2, 3, 5])
  })

  it('css 取选择器与 at 规则', () => {
    const lines = ['@media (max-width: 600px) {', '  .hero {', '    color: red;', '  }', '}']
    expect(outlineOf('a.css', lines).map((e) => e.line)).toEqual([1, 2])
  })

  it('单行 css 规则也进大纲', () => {
    expect(outlineOf('a.css', ['.hero { color: red; }']).map((e) => e.line)).toEqual([1])
  })

  it('vue 的脚本段不会被 css 选择器规则误伤', () => {
    const lines = ['<script setup>', 'if (ok) {', '  const map = {', '  }', '}', '</script>']
    // 只有 script 开标签和 const 声明进大纲:if 行和闭标签都不进
    expect(outlineOf('a.vue', lines).map((e) => e.line)).toEqual([1, 3])
  })

  it('js 取顶层声明', () => {
    const lines = ['import x from "y"', 'export function go() {', '  const inner = 1', '}']
    expect(outlineOf('a.ts', lines).map((e) => e.line)).toEqual([2, 3])
  })

  it('认不出的类型返回空,不产出噪音大纲', () => {
    expect(outlineOf('a.bin', ['x', 'y'])).toEqual([])
  })
})

describe('unifiedDiff', () => {
  it('给出 @@ 头与增删行', () => {
    const out = unifiedDiff('a.css', 'a\nb\nc\n', 'a\nB\nc\n')
    expect(out).toContain('--- a.css')
    expect(out).toContain('@@ -1,3 +1,3 @@')
    expect(out).toContain('-b')
    expect(out).toContain('+B')
    expect(out).toContain(' a')
  })

  it('无差异时返回空串', () => {
    expect(unifiedDiff('a.css', 'a\n', 'a\n')).toBe('')
  })

  it('远隔的两处改动切成两个 hunk', () => {
    const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 1', 'LINE 1').replace('line 38', 'LINE 38')
    expect(unifiedDiff('a.txt', before, after).match(/^@@/gm)).toHaveLength(2)
  })
})

describe('parsePatch', () => {
  const wrap = (...body: string[]): string =>
    ['*** Begin Patch', ...body, '*** End Patch'].join('\n')

  it('解析 update / add / delete 三种段', () => {
    const ops = parsePatch(
      wrap(
        '*** Update File: css/style.css',
        '@@',
        ' .hero {',
        '-  color: red;',
        '+  color: blue;',
        ' }',
        '*** Add File: css/theme.css',
        '+:root { --brand: #1677ff; }',
        '*** Delete File: css/old.css'
      )
    )

    expect(ops).toEqual([
      {
        kind: 'update',
        path: 'css/style.css',
        hunks: [
          {
            before: '.hero {\n  color: red;\n}',
            after: '.hero {\n  color: blue;\n}'
          }
        ]
      },
      { kind: 'add', path: 'css/theme.css', content: ':root { --brand: #1677ff; }\n' },
      { kind: 'delete', path: 'css/old.css' }
    ])
  })

  it('一个文件多个 hunk', () => {
    const ops = parsePatch(
      wrap('*** Update File: a.css', '@@', ' x', '-1', '+2', '@@', ' y', '-3', '+4')
    )
    expect(ops[0].kind === 'update' && ops[0].hunks).toHaveLength(2)
  })

  it('缺 Begin / End 时给出可读错误', () => {
    expect(() => parsePatch('*** Update File: a.css')).toThrow(/Begin Patch/)
    expect(() => parsePatch('*** Begin Patch\n*** Update File: a.css')).toThrow(/End Patch/)
  })

  it('只有新增行、没有上下文的 hunk 被拒绝', () => {
    expect(() => parsePatch(wrap('*** Update File: a.css', '@@', '+新增'))).toThrow(/定位不到/)
  })

  it('行首字符非法时报错', () => {
    expect(() => parsePatch(wrap('*** Update File: a.css', '@@', '?坏行'))).toThrow(/必须以空格/)
  })

  it('空行按上下文处理(模型常吃掉行首空格)', () => {
    const ops = parsePatch(wrap('*** Update File: a.css', '@@', ' a', '', '-b', '+c'))
    expect(ops[0].kind === 'update' && ops[0].hunks[0].before).toBe('a\n\nb')
  })

  it('补丁能落到 VFS 上', () => {
    const fs = vfs()
    const ops = parsePatch(
      wrap('*** Update File: index.html', '@@', ' <h1>你好</h1>', '-<p>world</p>', '+<p>世界</p>')
    )
    const op = ops[0]
    if (op.kind !== 'update') throw new Error('应当是 update')
    fs.multiEdit(
      op.path,
      op.hunks.map((h) => ({ oldText: h.before, newText: h.after }))
    )
    expect(fs.writes.get('index.html')).toBe('<h1>你好</h1>\n<p>世界</p>\n')
  })
})
