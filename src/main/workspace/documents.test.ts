import { mkdtempSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeAll, describe, expect, it } from 'vitest'
import { extractDocument, isSupportedDocument } from './documents'

/**
 * 用**真实文件**测,不用构造的字节。
 *
 * 夹具来源都要跨平台可得,否则这套测试只能在我这台机器上跑:
 * - docx:mammoth 自带的测试夹具,是真 Word 生成的(node_modules 里就有)
 * - xlsx:用 exceljs 现写一个,内容完全可控
 * - pdf:手写一份最小合法 PDF
 *
 * 曾经用 macOS 的 textutil 造过 docx,结果它把 UTF-8 的 HTML 当传统编码读,
 * 生成的 document.xml 里存的就是乱码——排查了半天发现是夹具坏了不是解析坏了。
 * 教训:夹具要么来自可信来源,要么内容由自己完全掌控。
 */

/** mammoth 自带的真 Word 文件 */
const MAMMOTH_FIXTURES = join(
  process.cwd(),
  'node_modules/.pnpm/mammoth@1.12.0/node_modules/mammoth/test/test-data'
)

const hasMammothFixtures = (() => {
  try {
    return readdirSync(MAMMOTH_FIXTURES).some((f) => f.endsWith('.docx'))
  } catch {
    return false
  }
})()

const dir = mkdtempSync(join(tmpdir(), 'docs-'))

/** 最小但结构合法的 PDF:一页,一行文本 */
function writeMinimalPdf(path: string): void {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ]
  const stream = 'BT /F1 24 Tf 72 700 Td (Design Spec Alpha) Tj ET'
  objects.push(`5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`)

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

beforeAll(async () => {
  const ExcelJS = (await import('exceljs')).default
  const book = new ExcelJS.Workbook()

  const metrics = book.addWorksheet('指标')
  metrics.addRow(['指标名', '本月', '环比'])
  metrics.addRow(['活跃用户', 12345, 0.083])
  metrics.addRow(['留存率', 0.61, -0.02])
  metrics.getCell('D2').value = { formula: 'B2*2', result: 24690 }

  const notes = book.addWorksheet('备注')
  notes.addRow(['日期', '说明'])
  notes.addRow([new Date('2026-07-01T00:00:00Z'), '含|竖线的文本'])

  await book.xlsx.writeFile(join(dir, 'data.xlsx'))

  writeFileSync(join(dir, 'table.csv'), '名称,数量\n螺丝,10\n"含,逗号",5\n')
  writeMinimalPdf(join(dir, 'spec.pdf'))
})

describe('xlsx', () => {
  it('多工作表各出一张 markdown 表', async () => {
    const out = await extractDocument(join(dir, 'data.xlsx'))
    expect(out.text).toContain('工作表:指标')
    expect(out.text).toContain('工作表:备注')
    expect(out.note).toContain('2 个工作表')
  })

  it('表格是合法 markdown:有表头分隔行', async () => {
    const out = await extractDocument(join(dir, 'data.xlsx'))
    expect(out.text).toMatch(/\| 指标名 \| 本月 \| 环比 \|[\s\S]*\| --- \|/)
  })

  it('公式取的是计算结果而不是公式串', async () => {
    const out = await extractDocument(join(dir, 'data.xlsx'))
    expect(out.text).toContain('24690')
    expect(out.text).not.toContain('B2*2')
  })

  it('日期转成可读格式', async () => {
    expect((await extractDocument(join(dir, 'data.xlsx'))).text).toContain('2026-07-01')
  })

  it('单元格里的竖线要转义,否则会把表格结构冲散', async () => {
    expect((await extractDocument(join(dir, 'data.xlsx'))).text).toContain('含\\|竖线的文本')
  })
})

describe('csv', () => {
  it('转成 markdown 表,引号里的逗号不算分隔', async () => {
    const out = await extractDocument(join(dir, 'table.csv'))
    expect(out.text).toContain('| 名称 | 数量 |')
    expect(out.text).toContain('| 含,逗号 | 5 |')
  })
})

describe('pdf', () => {
  it('抽出正文并标注页数', async () => {
    const out = await extractDocument(join(dir, 'spec.pdf'))
    expect(out.text).toContain('Design Spec Alpha')
    expect(out.note).toContain('1 页')
  })
})

describe.skipIf(!hasMammothFixtures)('docx(mammoth 自带的真 Word 文件)', () => {
  it('表格转成合法 markdown,带表头分隔行', async () => {
    const out = await extractDocument(join(MAMMOTH_FIXTURES, 'tables.docx'))
    expect(out.text).toContain('| Top left | Top right |')
    // 这条曾经缺失:逐个 <tr> 转换时没有"第一行"的概念,补不出分隔行
    expect(out.text).toContain('| --- | --- |')
    expect(out.text).toContain('| Bottom left | Bottom right |')
  })

  it('列表转成 markdown 列表', async () => {
    const out = await extractDocument(join(MAMMOTH_FIXTURES, 'simple-list.docx'))
    expect(out.text).toContain('- Apple')
    expect(out.text).toContain('- Banana')
  })

  it('普通段落原样取出', async () => {
    const out = await extractDocument(join(MAMMOTH_FIXTURES, 'single-paragraph.docx'))
    expect(out.text).toContain('Walking on imported air')
  })

  it('不留 html 标签残渣', async () => {
    const out = await extractDocument(join(MAMMOTH_FIXTURES, 'tables.docx'))
    expect(out.text).not.toMatch(/<\/?[a-z]+[^>]*>/i)
  })
})

describe('类型判断与错误', () => {
  it('认得出支持的类型', () => {
    expect(isSupportedDocument('a.pdf')).toBe(true)
    expect(isSupportedDocument('a.docx')).toBe(true)
    expect(isSupportedDocument('a.xlsx')).toBe(true)
    expect(isSupportedDocument('a.md')).toBe(true)
    expect(isSupportedDocument('a.png')).toBe(false)
  })

  it('不支持的类型给出可读错误', async () => {
    writeFileSync(join(dir, 'x.bin'), 'x')
    await expect(extractDocument(join(dir, 'x.bin'))).rejects.toThrow(/不支持的文件类型/)
  })
})
