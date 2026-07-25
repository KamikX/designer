import { readFileSync } from 'fs'
import { bgraToPng } from './png'

/**
 * PDF 的读取与渲染,底层是 PDFium(Chrome 自己的 PDF 引擎)的 WASM 版。
 *
 * ## 为什么从 pdf.js 换过来
 *
 * 拿一份真实的中文 PDF(202 页,嵌入 Type1 字体)实测:
 *
 * | 引擎 | 抽文字 | 渲染 |
 * | --- | --- | --- |
 * | pdf.js / unpdf | 4 万字符全是 `%` `!` | 同样是乱码 |
 * | PDFium | 中文正确 | 正确,8ms |
 *
 * pdf.js 解析不了那份文档的 Type1 字体(`Unknown type 1 charstring command`),
 * 于是退回后备字体,把**字形码本身**当 ASCII 画了出来。这意味着"抽不出
 * 文字就渲染成图给多模态模型"这条兜底路一起失效——两边根因是同一个字体。
 * 换成 PDFium 之后两条路都对了。
 *
 * ## 为什么不是 MuPDF
 *
 * MuPDF 抽取质量同样好,但它是 **AGPL-3.0**:闭源分发就得开源整个应用。
 * PDFium 是 BSD-3-Clause,这个绑定是 MIT,没有这个包袱。
 *
 * ## 为什么不引原生依赖
 *
 * PDFium 走 WASM,一份 11MB 跨所有平台;原来的 `@napi-rs/canvas` 是每平台
 * 25MB 的原生二进制,还要处理打包与签名。位图转 PNG 自己写(见 png.ts),
 * 于是整条链路零原生依赖。
 */

/** WASM 实例很贵,初始化一次全进程复用 */
let library: Promise<import('@hyzyla/pdfium').PDFiumLibrary> | null = null

async function getLibrary(): Promise<import('@hyzyla/pdfium').PDFiumLibrary> {
  library ??= (async () => {
    const { PDFiumLibrary } = await import('@hyzyla/pdfium')
    return PDFiumLibrary.init()
  })()
  return library
}

export interface PdfText {
  /** 按页拼好的正文 */
  text: string
  pageCount: number
}

/** 抽取全文,按页加分隔标记 */
export async function extractPdfText(path: string): Promise<PdfText> {
  const lib = await getLibrary()
  const doc = await lib.loadDocument(readFileSync(path))
  try {
    const parts: string[] = []
    let pageCount = 0
    for (const page of doc.pages()) {
      pageCount++
      parts.push(`--- 第 ${pageCount} 页 ---\n${page.getText().trim()}`)
    }
    return { text: parts.join('\n\n'), pageCount }
  } finally {
    doc.destroy()
  }
}

/** 只数页数,不渲染。Electron 那条路自己不知道总页数,得从这里问 */
export async function countPdfPages(path: string): Promise<number> {
  const lib = await getLibrary()
  const doc = await lib.loadDocument(readFileSync(path))
  try {
    // 这个绑定只提供迭代器,没有直接的页数接口,只能数一遍
    return [...doc.pages()].length
  } finally {
    doc.destroy()
  }
}

export interface RenderedPage {
  data: Buffer
  mime: string
  page: number
}

/**
 * 渲染指定页为 PNG。
 *
 * @param width 目标宽度。模型按像素计费,这里定死上限而不是让调用方随意放大
 */
export async function renderPdfPageRange(
  path: string,
  from: number,
  count: number,
  width: number
): Promise<{ pages: RenderedPage[]; pageCount: number }> {
  const lib = await getLibrary()
  const doc = await lib.loadDocument(readFileSync(path))
  try {
    const pages: RenderedPage[] = []
    let index = 0
    for (const page of doc.pages()) {
      index++
      if (index < from) continue
      if (pages.length >= count) break

      const { originalWidth } = page.getOriginalSize()
      // 小页面不要放大:糊掉的大图既贵又更难认
      const scale = Math.min(width / Math.max(originalWidth, 1), 3)
      const rendered = await page.render({ scale, render: 'bitmap' })
      pages.push({
        data: bgraToPng(rendered.data, rendered.width, rendered.height),
        mime: 'image/png',
        page: index
      })
    }
    return { pages, pageCount: doc.getPageCount?.() ?? index }
  } finally {
    doc.destroy()
  }
}
