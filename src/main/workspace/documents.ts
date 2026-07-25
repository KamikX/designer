import { readFileSync, statSync } from 'fs'
import { basename, extname } from 'path'
import { assessExtraction } from './extract-quality'
import type { ExtractionVerdict } from './extract-quality'

/**
 * 文档抽取:pdf / docx / xlsx / csv / 纯文本 → 给模型看的文字。
 *
 * 用途是"读需求文档、读数据表,然后照着做设计稿",所以目标不是完美还原
 * 排版,是**把信息捞出来**。表格转成 markdown、pdf 按页拼、docx 取纯文本,
 * 到此为止;要看版式请用截图走识图那条路。
 *
 * 三个解析库都是动态 import:不碰文档的用户永远不加载这几 MB,
 * 冷启动零开销(和 @aws-sdk/client-s3 一个思路)。
 */

/** 抽取结果的字符上限。文档动辄几十万字,不截断一份就能吃光上下文 */
const MAX_CHARS = 40000
/** 单个文件大小上限 */
const MAX_BYTES = 30 * 1024 * 1024
/** 表格最多取多少行——看结构用不着全量 */
const MAX_ROWS = 200

export interface ExtractedDocument {
  /** 给模型看的正文 */
  text: string
  /** 一句话说明来源与规模,让模型知道自己看到的是不是全部 */
  note: string
  /**
   * 抽出来的文字到底能不能用。
   *
   * 扫描件和字体坏掉的 PDF **都不会报错**,只会安静地返回空白或乱码。
   * 调用方拿到 usable:false 时应当改走图片那条路,而不是把垃圾喂给模型。
   */
  verdict: ExtractionVerdict
  /** pdf 的页数,决定要不要渲染以及渲染几页 */
  pageCount?: number
}

const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.html',
  '.htm',
  '.xml',
  '.css',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.vue',
  '.svelte',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.sh',
  '.sql',
  '.log'
])

export function isSupportedDocument(path: string): boolean {
  const ext = extname(path).toLowerCase()
  return TEXT_EXT.has(ext) || ['.pdf', '.docx', '.xlsx', '.xls', '.csv'].includes(ext)
}

export async function extractDocument(path: string): Promise<ExtractedDocument> {
  const stat = statSync(path)
  if (stat.size > MAX_BYTES) {
    throw new Error(
      `文件 ${Math.round(stat.size / 1024 / 1024)}MB,超过 ${MAX_BYTES / 1024 / 1024}MB 上限。`
    )
  }

  const ext = extname(path).toLowerCase()
  const name = basename(path)

  switch (ext) {
    case '.pdf': {
      const pdf = await fromPdf(path)
      return cap(pdf, name, pdf.pageCount)
    }
    case '.docx':
      return cap(await fromDocx(path), name)
    case '.xlsx':
    case '.xls':
      return cap(await fromSpreadsheet(path), name)
    case '.csv':
      return cap(fromCsv(path), name)
    default:
      if (!TEXT_EXT.has(ext)) {
        throw new Error(
          `不支持的文件类型 ${ext || '(无后缀)'}。支持 pdf / docx / xlsx / csv 与常见文本。`
        )
      }
      return cap({ text: readFileSync(path, 'utf-8'), note: '' }, name)
  }
}

function cap(
  input: { text: string; note: string },
  name: string,
  pageCount?: number
): ExtractedDocument {
  const text = input.text.replace(/\n{3,}/g, '\n\n').trim()
  // 判定用**截断前**的全文:截断是我们主动做的,不该被算成"抽取失败"
  const verdict = assessExtraction(text, pageCount)

  if (text.length <= MAX_CHARS) {
    return { text, note: input.note || `${name},${text.length} 字符`, verdict, pageCount }
  }
  return {
    text: text.slice(0, MAX_CHARS),
    note: `${name},共 ${text.length} 字符,已截断到前 ${MAX_CHARS} 字符${input.note ? `(${input.note})` : ''}`,
    verdict,
    pageCount
  }
}

async function fromPdf(path: string): Promise<{ text: string; note: string; pageCount: number }> {
  const { extractPdfText } = await import('./pdf')
  const { text, pageCount } = await extractPdfText(path)
  return { text, note: `共 ${pageCount} 页`, pageCount }
}

async function fromDocx(path: string): Promise<{ text: string; note: string }> {
  const mammoth = await import('mammoth')
  // 走 html 而不是 extractRawText:后者把标题、列表、表格全压成一坨纯文本,
  // 结构信息没了;html 再降级成 markdown,层级能留住
  const result = await mammoth.convertToHtml({ path })
  return { text: htmlToMarkdown(result.value), note: '' }
}

async function fromSpreadsheet(path: string): Promise<{ text: string; note: string }> {
  const ExcelJS = await import('exceljs')
  const book = new ExcelJS.default.Workbook()
  await book.xlsx.readFile(path)

  const sheets: string[] = []
  for (const sheet of book.worksheets) {
    const rows: string[][] = []
    sheet.eachRow((row, index) => {
      if (index > MAX_ROWS) return
      const values = Array.isArray(row.values) ? row.values.slice(1) : []
      rows.push(values.map((v) => cellText(v)))
    })
    if (rows.length === 0) continue
    sheets.push(`### 工作表:${sheet.name}(${sheet.rowCount} 行)\n\n${toMarkdownTable(rows)}`)
  }
  return {
    text: sheets.join('\n\n'),
    note: `${book.worksheets.length} 个工作表,每表最多取 ${MAX_ROWS} 行`
  }
}

function fromCsv(path: string): { text: string; note: string } {
  const raw = readFileSync(path, 'utf-8')
  const lines = raw.split(/\r?\n/).filter((l) => l.trim())
  const rows = lines.slice(0, MAX_ROWS).map(splitCsvLine)
  return { text: toMarkdownTable(rows), note: `共 ${lines.length} 行` }
}

/** 够用的 CSV 拆分:处理双引号包裹与转义的双引号 */
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

/**
 * html → markdown 的够用版。
 *
 * 只认 mammoth 会产出的那几种标签(标题、列表、表格、加粗、链接),
 * 目的是把层级留住,不是做通用转换——引一个 turndown 不值当。
 */
function htmlToMarkdown(html: string): string {
  return (
    html
      // 表格必须按**整张**处理:逐个 <tr> 转换的话没有"第一行"的概念,
      // 补不出 `| --- |` 分隔行,产出的就不是合法 markdown 表格
      .replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, body: string) => {
        const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) =>
          [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => strip(cell[1]))
        )
        const useful = rows.filter((cells) => cells.length > 0)
        return useful.length ? `\n${toMarkdownTable(useful)}\n` : ''
      })
      .replace(
        /<h([1-6])[^>]*>(.*?)<\/h\1>/gis,
        (_, level: string, inner: string) => `\n${'#'.repeat(Number(level))} ${strip(inner)}\n`
      )
      .replace(/<li[^>]*>(.*?)<\/li>/gis, (_, inner: string) => `- ${strip(inner)}\n`)
      .replace(/<\/(ul|ol)>/gi, '\n')
      .replace(/<(strong|b)[^>]*>(.*?)<\/\1>/gis, (_, __, inner: string) => `**${strip(inner)}**`)
      .replace(/<(em|i)[^>]*>(.*?)<\/\1>/gis, (_, __, inner: string) => `*${strip(inner)}*`)
      .replace(
        /<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis,
        (_, href: string, inner: string) => `[${strip(inner)}](${href})`
      )
      .replace(/<p[^>]*>(.*?)<\/p>/gis, (_, inner: string) => `\n${strip(inner)}\n`)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
  )
}

function strip(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function cellText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'object') {
    // exceljs 的富文本 / 公式 / 超链接单元格
    const obj = value as { text?: string; result?: unknown; richText?: { text: string }[] }
    if (obj.richText) return obj.richText.map((r) => r.text).join('')
    if (obj.text) return obj.text
    if (obj.result != null) return String(obj.result)
    if (value instanceof Date) return value.toISOString().slice(0, 10)
    return ''
  }
  return String(value)
}

function toMarkdownTable(rows: string[][]): string {
  if (rows.length === 0) return '(空)'
  const width = Math.max(...rows.map((r) => r.length))
  const norm = rows.map((r) => {
    const padded = [...r]
    while (padded.length < width) padded.push('')
    return padded.map((c) => c.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim())
  })
  const [head, ...body] = norm
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`)
  ].join('\n')
}
