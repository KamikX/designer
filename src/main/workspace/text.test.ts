import { describe, expect, it } from 'vitest'
import { decode, sniff } from './text'

/**
 * 这里守的是一条很容易被漏掉的失败模式:**Node 读非 UTF-8 文件不会抛错**,
 * 它把非法字节静默替换成 U+FFFD 然后正常返回。于是模型收到一屏乱码,却以为
 * 那就是文件内容,接着照着乱码做判断。
 *
 * 所以每条"读不了"的用例,真正断言的是"我们**主动**发现了它读不了",
 * 而不是"读出来是空的"。
 */

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf-8')

function ok(buffer: Buffer): { encoding: string; text: string } {
  const probe = sniff(buffer.subarray(0, 8192))
  if (!probe.ok) throw new Error(`本该可读却被拒:${probe.reason}`)
  return { encoding: probe.encoding, text: decode(buffer, probe.encoding, probe.bomBytes) }
}

function rejected(buffer: Buffer): string {
  const probe = sniff(buffer.subarray(0, 8192))
  if (probe.ok) throw new Error('本该拒绝却放行了')
  return probe.reason
}

describe('读得了的', () => {
  it('纯 ASCII', () => {
    expect(ok(utf8('hello\nworld\n')).text).toBe('hello\nworld\n')
  })

  it('中文 UTF-8', () => {
    expect(ok(utf8('设计体系\n主色 #4f6ef7\n')).text).toBe('设计体系\n主色 #4f6ef7\n')
  })

  it('空文件', () => {
    expect(ok(Buffer.alloc(0)).text).toBe('')
  })

  it('带 BOM 的 UTF-8:BOM 不该出现在正文里', () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('# 标题\n')])
    expect(ok(withBom).text).toBe('# 标题\n')
  })

  it('带 BOM 的 UTF-16LE', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文 text\n', 'utf16le')])
    const out = ok(buf)
    expect(out.encoding).toBe('utf16le')
    expect(out.text).toBe('中文 text\n')
  })

  it('带 BOM 的 UTF-16BE', () => {
    const le = Buffer.from('中文 text\n', 'utf16le')
    const be = Buffer.from(le).swap16()
    const out = ok(Buffer.concat([Buffer.from([0xfe, 0xff]), be]))
    expect(out.encoding).toBe('utf16be')
    expect(out.text).toBe('中文 text\n')
  })

  it('制表与换行不算控制字符', () => {
    expect(ok(utf8('a\tb\r\nc\n')).text).toContain('\t')
  })

  it('结尾被截断的多字节序列不算错——我们只嗅探前 8KB', () => {
    const long = utf8('中'.repeat(4000)) // 12000 字节,第 8192 字节必然切在字符中间
    expect(() => ok(long)).not.toThrow()
  })
})

describe('魔数只是诊断层,不是判定依据', () => {
  it('认得出格式时,说"这是 PNG 图片"而不是"含有 NUL 字节"', () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(32)
    ])
    expect(rejected(png)).toContain('PNG')
  })

  it('PDF 被标记为可用文档工具读——后缀说谎时靠这个纠正', () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from([0x00, 0x01])])
    const probe = sniff(pdf)
    expect(probe.ok).toBe(false)
    if (probe.ok) return
    expect(probe.format?.readableAsDocument).toBe(true)
  })

  it('**没有魔数的 GBK 文本照样被拒**——这正是魔数替代不了 UTF-8 解码的地方', () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])
    const probe = sniff(gbk)
    expect(probe.ok).toBe(false)
    if (probe.ok) return
    // 识别不出格式,但依然明确拒绝并说明原因
    expect(probe.format).toBeUndefined()
    expect(probe.reason).toContain('UTF-8')
  })

  it('魔数不会把正常文本误判成二进制', () => {
    expect(ok(utf8('PK is a person, not a zip\n')).text).toContain('PK is')
  })
})

describe('读不了的必须被主动发现,并说清原因', () => {
  it('含 NUL 字节且认得出格式的,直接说是什么格式', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x41, 0x42])
    expect(rejected(zip)).toContain('zip')
  })

  it('含 NUL 字节但认不出格式的,退回通用理由', () => {
    const unknown = Buffer.from([0x13, 0x37, 0x00, 0x42, 0x00, 0x99])
    expect(rejected(unknown)).toContain('NUL')
  })

  it('无后缀的二进制照样被认出来', () => {
    // 典型的 ELF 头,后缀黑名单完全帮不上忙
    const elf = Buffer.concat([
      Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]),
      Buffer.alloc(64)
    ])
    expect(rejected(elf)).toContain('ELF')
  })

  it('GBK 编码的中文(非法 UTF-8 序列)', () => {
    // "中文" 的 GBK 字节,不含 NUL,只能靠严格解码判出来
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])
    expect(rejected(gbk)).toContain('UTF-8')
  })

  it('UTF-32 明确不支持', () => {
    const utf32 = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00, 0x00, 0x00])
    expect(rejected(utf32)).toContain('UTF-32')
  })

  it('控制字符过多', () => {
    const noisy = Buffer.concat([utf8('ok'), Buffer.from(new Array(200).fill(0x01))])
    expect(rejected(noisy)).toContain('控制字符')
  })

  it('拒绝的理由都是给人看的中文,能直接放进工具结果', () => {
    const reason = rejected(Buffer.from([0x00, 0x01, 0x02]))
    expect(reason.length).toBeGreaterThan(6)
    expect(reason).toMatch(/[一-龥]/)
  })
})
