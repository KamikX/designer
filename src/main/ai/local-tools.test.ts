import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildLocalTools, localScopePrompt, salvageReadable } from './local-tools'
import type { WorkspaceRoot } from '../../shared/types'

/**
 * check_local_path 是个**探测原语**:给一个路径,回答它存不存在。所以这里
 * 最要紧的一条不是"能不能查到",而是**范围之外绝不能泄露存在性**——
 * 否则模型被诱导着逐个试 ~/.ssh/id_rsa 之类的路径,靠"存在/不存在"的差别
 * 就能把一台机器的目录结构摸出来。
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), 'local-tools-')))
const granted = join(base, 'granted')
const outside = join(base, 'outside')
mkdirSync(join(granted, 'src'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(granted, 'readme.md'), '# hi\n')
writeFileSync(
  join(granted, 'photo.png'),
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
)
writeFileSync(join(outside, 'secret.env'), 'TOKEN=1\n')
// 后缀完全无辜、内容却是二进制——后缀黑名单挡不住的那一类
writeFileSync(join(granted, 'data.txt'), Buffer.from([0x00, 0x01, 0x02, 0x41, 0x42, 0x00]))
// GBK 中文:不含 NUL,只能靠严格解码判出来
writeFileSync(join(granted, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a]))
writeFileSync(join(granted, 'empty.txt'), '')

const roots: WorkspaceRoot[] = [{ id: 'r1', projectId: 'p', path: granted, name: 'granted' }]

async function raw(
  name: string,
  input: unknown,
  opts: { canSeeImages: boolean } = { canSeeImages: false },
  on = roots
): Promise<unknown> {
  const tools = buildLocalTools(on, opts)
  const entry = tools[name]
  if (!entry?.execute) throw new Error(`没有工具 ${name}`)
  return entry.execute(input as never, { toolCallId: 't', messages: [] } as never)
}

async function call(name: string, input: unknown, on = roots): Promise<string> {
  return String(await raw(name, input, { canSeeImages: false }, on))
}

/** 造一份没有任何文字对象的 PDF——就是扫描件的等价物 */
function writeScannedPdf(path: string): void {
  const content = '0.8 g 50 50 500 700 re f'
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const object of objects) {
    offsets.push(pdf.length)
    pdf += object
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  writeFileSync(path, pdf, 'latin1')
}

beforeAll(() => {
  writeScannedPdf(join(granted, 'scan.pdf'))
})

describe('抽不出文字的文档,按模型能力分流', () => {
  it('没有识图能力:说清楚读不了,并给出可执行的建议,**绝不给图**', async () => {
    const out = await raw('read_local_document', { path: 'granted/scan.pdf' })
    expect(typeof out).toBe('string')
    expect(String(out)).toContain('读不出可用文字')
    expect(String(out)).toContain('换一个带识图能力的模型')
  })

  it('没有识图能力时,取图工具压根不注册', () => {
    const tools = buildLocalTools(roots, { canSeeImages: false })
    expect(tools.read_document_images).toBeUndefined()
  })

  it('有识图能力:自动改走图片,返回可直接喂给模型的图片内容块', async () => {
    const out = (await raw(
      'read_local_document',
      { path: 'granted/scan.pdf' },
      { canSeeImages: true }
    )) as { type: string; value: { type: string; mediaType?: string }[] }

    expect(out.type).toBe('content')
    expect(out.value[0].type).toBe('text')
    expect(out.value.some((part) => part.type === 'file' && part.mediaType === 'image/png')).toBe(
      true
    )
  })

  it('有识图能力时才注册取图工具', () => {
    const tools = buildLocalTools(roots, { canSeeImages: true })
    expect(tools.read_document_images).toBeDefined()
  })
})

describe('没有授权时整组工具不注册', () => {
  it('一个工具都拿不到', () => {
    expect(Object.keys(buildLocalTools([]))).toEqual([])
  })
})

describe('check_local_path', () => {
  it('范围内的目录', async () => {
    expect(await call('check_local_path', { path: 'granted' })).toContain('目录')
  })

  it('范围内的文本文件,指明该用哪个工具读', async () => {
    const out = await call('check_local_path', { path: 'granted/readme.md' })
    expect(out).toContain('文件')
    expect(out).toContain('read_local_file')
  })

  it('范围内的二进制文件如实说读不了', async () => {
    expect(await call('check_local_path', { path: 'granted/photo.png' })).toContain('读不了')
  })

  it('check 与 read 对同一个文件的判定必须一致', async () => {
    // 两个工具给相反答案时,模型会在"能读"和"读不了"之间反复横跳
    for (const path of ['granted/photo.png', 'granted/data.txt', 'granted/readme.md']) {
      const checkSaysNo = (await call('check_local_path', { path })).includes('读不了')
      const readSaysNo = (await call('read_local_file', { path })).includes('读不了')
      expect(checkSaysNo).toBe(readSaysNo)
    }
  })

  it('范围内不存在的路径:说清楚不在范围内或不存在', async () => {
    expect(await call('check_local_path', { path: 'granted/nope.md' })).toContain('不在授权范围内')
  })

  it('范围外**存在**的文件与范围外**不存在**的文件,回答必须一模一样', async () => {
    // 这是核心断言:两者可区分就等于开了一个文件系统探测通道
    const real = await call('check_local_path', { path: join(outside, 'secret.env') })
    const fake = await call('check_local_path', { path: join(outside, 'no-such-file.env') })
    expect(real.replace(join(outside, 'secret.env'), 'X')).toBe(
      fake.replace(join(outside, 'no-such-file.env'), 'X')
    )
    expect(real).toContain('不在授权范围内')
    expect(real).not.toContain('TOKEN')
  })
})

describe('读不了的文件要明确说读不了,而不是返回一坨乱码', () => {
  it('后缀是 .txt 但内容是二进制', async () => {
    const out = await call('read_local_file', { path: 'granted/data.txt' })
    expect(out).toContain('读不了')
    expect(out).toContain('NUL')
    // 最关键:不能把 U+FFFD 乱码当内容吐出来
    expect(out).not.toContain('\uFFFD')
  })

  it('GBK 编码的文件', async () => {
    const out = await call('read_local_file', { path: 'granted/gbk.txt' })
    expect(out).toContain('读不了')
    expect(out).toContain('UTF-8')
    expect(out).not.toContain('\uFFFD')
  })

  it('空文件如实说是空的,不是返回一片空白', async () => {
    expect(await call('read_local_file', { path: 'granted/empty.txt' })).toContain('空文件')
  })

  it('check_local_path 按内容判定,不被后缀骗过去', async () => {
    const out = await call('check_local_path', { path: 'granted/data.txt' })
    expect(out).toContain('读不了')
    const good = await call('check_local_path', { path: 'granted/readme.md' })
    expect(good).toContain('可以当文本读')
  })

  it('搜索会跳过不可读的文件,不产生乱码命中', async () => {
    // data.txt 里有可打印的 "AB",若不做内容嗅探就会被搜出来
    const out = await call('search_local', { query: 'AB' })
    expect(out).not.toContain('data.txt')
  })
})

describe('读取工具守着同一条边界', () => {
  it('范围外的文件读不到', async () => {
    expect(await call('read_local_file', { path: join(outside, 'secret.env') })).toContain(
      '不在授权范围内'
    )
  })

  it('单文件授权时,list_local_dir 给出可读的指引而不是报错', async () => {
    const fileRoot: WorkspaceRoot[] = [
      { id: 'r2', projectId: 'p', path: join(granted, 'readme.md'), name: 'readme.md' }
    ]
    const out = await call('list_local_dir', {}, fileRoot)
    expect(out).toContain('是一个文件')
    expect(out).toContain('read_local_file')
  })
})

describe('Electron 高保真渲染的降级', () => {
  it('纯 node 环境(没有 electron)也能出图——静默退回 WASM', async () => {
    // 这条测试本身就跑在没有 electron 的环境里,所以它验证的正是降级路径。
    // 降级要是不通,扫描件那条路在单测里就直接炸了
    const out = (await raw(
      'read_local_document',
      { path: 'granted/scan.pdf' },
      { canSeeImages: true }
    )) as { type: string; value: { type: string; mediaType?: string; text?: string }[] }

    expect(out.type).toBe('content')
    expect(out.value.some((p) => p.type === 'file' && p.mediaType === 'image/png')).toBe(true)
  })

  it('退回 WASM 时要告诉模型这批图可能缺字', async () => {
    const out = (await raw(
      'read_local_document',
      { path: 'granted/scan.pdf' },
      { canSeeImages: true }
    )) as { value: { type: string; text?: string }[] }
    const banner = out.value.find((p) => p.type === 'text')?.text ?? ''
    expect(banner).toContain('内置渲染器')
  })
})

describe('乱码里捞可读内容', () => {
  it('混合字体的文档:抽坏的行丢掉,能读的行留下', () => {
    const mixed = [
      '本书针对男性阳痿等症',
      '%%%%%%%%%%%%%%%%%%%%',
      '"#$%%%%%%%%%%%%%%%%%',
      '第一章 食疗方剂',
      '! " # $ # % # &’’'
    ].join('\n')
    const out = salvageReadable(mixed)
    expect(out).toContain('本书针对男性阳痿等症')
    expect(out).toContain('第一章 食疗方剂')
    expect(out).not.toContain('%%%%')
  })

  it('全是乱码时捞不出东西,不硬凑', () => {
    expect(salvageReadable('%%%%%%\n"#$%%%\n! " # $')).toBe('')
  })

  it('太短的行不算——页码分隔之类的残渣', () => {
    expect(salvageReadable('第 1 页\nab')).toBe('')
  })

  it('有字符上限,不会把整份乱码文档塞回去', () => {
    expect(salvageReadable('这是一段可读的中文内容\n'.repeat(500)).length).toBeLessThanOrEqual(1500)
  })
})

describe('localScopePrompt', () => {
  it('没授权也没写错路径时不占位置', () => {
    expect(localScopePrompt([])).toBe('')
  })

  it('没授权但用户写错了路径:仍要把写错这件事告诉模型', () => {
    const out = localScopePrompt([], ['/tmp/typo.md'])
    expect(out).toContain('不存在')
    expect(out).toContain('/tmp/typo.md')
  })

  it('有授权时列出范围', () => {
    expect(localScopePrompt(roots)).toContain('granted')
  })

  it('写错的路径要提示先向用户确认,而不是让模型接着猜', () => {
    expect(localScopePrompt(roots, ['/tmp/typo.md'])).toContain('先向用户确认')
  })
})
