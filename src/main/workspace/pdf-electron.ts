/**
 * 借 Electron 自带的 Chromium 渲染 PDF。
 *
 * ## 为什么要有这条路
 *
 * 我们打包的 PDFium 是 WASM 版,它**没有系统字体**,也没自带 CJK 后备字体。
 * 遇到"非嵌入的 CID TrueType 中文字体"时,替换不出字形,汉字整页画不出来
 * (实测某份 202 页的中文 PDF 就是这样)。
 *
 * 而 Electron 里跑的是**完整的 Chromium**:同一个 PDFium,但有系统字体访问、
 * 有完整的字体替换链路。同样的文件,Chrome 打开是能看的。
 *
 * 所以这条路不是"换个引擎",是"给同一个引擎补上它在 WASM 里缺的那部分环境"。
 *
 * ## 为什么不是默认路径
 *
 * 开一个隐藏窗口、等 PDF 插件加载、逐页导航截图,每页要几百毫秒到一秒;
 * WASM 渲染一页只要 8ms。所以默认还是 WASM,只有在**抽取判定为坏、确实
 * 要靠图片理解文档**时才走这条——那时质量才值得付这个代价。
 *
 * ## 尚未在真实 Electron 里验证
 *
 * 开发环境里无法无头启动 Electron,这条路径是照着 API 写的,没有跑通过。
 * 因此所有失败都吞掉并退回 WASM:**宁可画得差,也不能让读文档这件事挂掉**。
 */

/** 等 PDF 插件把页面画出来的时间。没有可靠的"渲染完成"事件,只能给个余量 */
const RENDER_SETTLE_MS = 900
/** 单页最长等待,超时就放弃这一页 */
const PAGE_TIMEOUT_MS = 8000

/** 视口尺寸。按 A4 比例给,配合 view=Fit 让页面尽量填满,少截到灰底 */
const VIEW_WIDTH = 1000
const VIEW_HEIGHT = 1414

export interface ElectronRenderedPage {
  data: Buffer
  mime: string
  page: number
}

/**
 * 渲染指定页。
 *
 * 任何一步失败都抛错,由调用方退回 WASM——这里不做部分成功,
 * 半份 Electron 半份 WASM 的结果混在一起更难排查。
 */
export async function renderPdfViaElectron(
  path: string,
  from: number,
  count: number
): Promise<ElectronRenderedPage[]> {
  // 动态 import:纯 node 环境(单测)里没有 electron,让它在这里抛,
  // 调用方 catch 之后走 WASM
  const { BrowserWindow } = await import('electron')

  const win = new BrowserWindow({
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
    show: false,
    webPreferences: {
      // Chromium 的 PDF 查看器是内置插件,不开这个开关不会渲染
      plugins: true,
      offscreen: true,
      sandbox: true,
      // 只是渲染一份本地 PDF,不需要也不该给它 node 能力
      nodeIntegration: false,
      contextIsolation: true
    }
  })

  try {
    const pages: ElectronRenderedPage[] = []
    for (let page = from; page < from + count; page++) {
      // 每页整份重新加载:只改 hash 时 PDF 插件不一定会重新定位,
      // 而这条路本来就慢,不差这一次导航
      const url = `${pathToUrl(path)}#page=${page}&toolbar=0&navpanes=0&scrollbar=0&view=Fit`
      await withTimeout(win.loadURL(url), PAGE_TIMEOUT_MS, `第 ${page} 页加载超时`)
      await delay(RENDER_SETTLE_MS)

      const image = await withTimeout(
        win.webContents.capturePage(),
        PAGE_TIMEOUT_MS,
        `第 ${page} 页截图超时`
      )
      if (image.isEmpty()) throw new Error(`第 ${page} 页截图为空`)
      pages.push({ data: image.toPNG(), mime: 'image/png', page })
    }
    return pages
  } finally {
    // 无论成败都要销毁,不然隐藏窗口会一直占着进程
    if (!win.isDestroyed()) win.destroy()
  }
}

function pathToUrl(path: string): string {
  // 中文路径、空格、括号都要转义,否则 loadURL 直接失败
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ])
}
