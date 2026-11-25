import { text as appText } from '../i18n'
import { extname } from 'path'

/**
 * 从文档里取图:PDF 渲染成页面图,docx 抠出内嵌图片。
 *
 * ## 什么时候需要它
 *
 * 1. **扫描件 PDF**——整份是图片,抽不出文字。这时渲染页面是唯一能让模型
 *    "看懂"的方式,不是锦上添花。
 * 2. **文档里的配图**——需求文档里的流程图、竞品截图,往往比正文更能说明
 *    要做成什么样。
 *
 * 两种都只在模型有识图能力时才有意义,门控在调用方(local-tools)。
 *
 * ## 为什么图片是按需取的
 *
 * 图片按像素尺寸计费,一份 20 页的扫描件全渲染进去能顶掉半个上下文。
 * 所以默认只给前几页 / 前几张,模型要更多再回来要——和文件、参考图那两套
 * 是同一个原则。
 */

/** 一次最多给几张图。再多就该让模型说清楚它到底要看哪一部分 */
export const MAX_IMAGES = 4
/** 渲染宽度。够看清版式与文字,又不至于把上下文烧光 */
const RENDER_WIDTH = 1400
/** 内嵌图片小于这个尺寸多半是图标或装饰,不值得占一次图片额度 */
const MIN_EMBEDDED_BYTES = 8 * 1024

export interface DocImage {
  data: Buffer
  mime: string
  /** 给模型的说明:第几页 / 第几张 */
  label: string
}

/**
 * 把 PDF 的指定页渲染成 PNG。
 *
 * 两条渲染路径:
 *
 * - **WASM 版 PDFium**(默认):一页 8ms,但没有系统字体,遇到非嵌入的中文
 *   字体会整页缺字
 * - **Electron 的 Chromium**(highFidelity):同一个 PDFium 但有完整字体环境,
 *   代价是每页几百毫秒
 *
 * 只有"抽不出文字、确实要靠图看懂文档"时才值得走第二条。Electron 那条
 * 任何失败都静默退回 WASM——宁可画得差,也不能让读文档整个挂掉。
 */
export async function renderPdfPages(
  path: string,
  options: { from?: number; count?: number; highFidelity?: boolean } = {}
): Promise<{ images: DocImage[]; totalPages: number; renderer: 'chromium' | 'wasm' }> {
  const { renderPdfPageRange, countPdfPages } = await import('./pdf')
  const from = Math.max(1, options.from ?? 1)
  const count = Math.min(options.count ?? MAX_IMAGES, MAX_IMAGES)

  if (options.highFidelity) {
    try {
      const { renderPdfViaElectron } = await import('./pdf-electron')
      const pages = await renderPdfViaElectron(path, from, count)
      if (pages.length > 0) {
        return {
          images: pages.map((page) => ({
            data: page.data,
            mime: page.mime,
            label: appText('workspace.docImages.page', page.page)
          })),
          totalPages: await countPdfPages(path),
          renderer: 'chromium'
        }
      }
    } catch {
      // 非 Electron 环境、插件没开、超时——都退回 WASM,不打断主流程
    }
  }

  const { pages, pageCount } = await renderPdfPageRange(path, from, count, RENDER_WIDTH)
  return {
    images: pages.map((page) => ({
      data: page.data,
      mime: page.mime,
      label: appText('workspace.docImages.page', page.page)
    })),
    totalPages: pageCount,
    renderer: 'wasm'
  }
}

const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/**
 * 抠出 docx / xlsx 里的内嵌图片。
 *
 * OOXML 就是个 zip,图片都躺在 word/media/ 或 xl/media/ 下,直接解压即可,
 * 不用为此再引一个库(adm-zip 项目里已经有了,技能包导入在用)。
 */
export async function extractEmbeddedImages(
  path: string,
  options: { from?: number; count?: number } = {}
): Promise<{ images: DocImage[]; total: number }> {
  const AdmZip = (await import('adm-zip')).default
  const zip = new AdmZip(path)

  const media = zip
    .getEntries()
    .filter((entry) => !entry.isDirectory && /(^|\/)(word|xl|ppt)\/media\//.test(entry.entryName))
    .filter((entry) => MEDIA_MIME[extname(entry.entryName).toLowerCase()])
    // 小图基本是项目符号、logo 之类的装饰,占一次额度不划算
    .filter((entry) => entry.header.size >= MIN_EMBEDDED_BYTES)
    .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }))

  const from = Math.max(1, options.from ?? 1)
  const count = Math.min(options.count ?? MAX_IMAGES, MAX_IMAGES)

  const images = media.slice(from - 1, from - 1 + count).map((entry, index) => ({
    data: entry.getData(),
    mime: MEDIA_MIME[extname(entry.entryName).toLowerCase()],
    label: appText('workspace.docImages.image', from + index, entry.entryName.split('/').pop())
  }))

  return { images, total: media.length }
}

/** 这个类型的文档能不能取图 */
export function canExtractImages(path: string): boolean {
  const ext = extname(path).toLowerCase()
  return ext === '.pdf' || ext === '.docx' || ext === '.xlsx' || ext === '.pptx'
}
