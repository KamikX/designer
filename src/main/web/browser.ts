/**
 * 无头浏览器:用 Electron 自带的 Chromium 打开页面、跑完 JS、取回内容。
 *
 * ## 为什么不是 fetch
 *
 * 现在大量页面(文档站、SPA、任何带前端框架的站点)首屏 HTML 里没有正文,
 * 内容是 JS 渲染出来的。`fetch` 拿到的是一个空壳,模型看到的是导航栏和
 * "正在加载"。而 Electron 里跑的是完整的 Chromium——和 PDF 那条路同一个
 * 思路:**我们手上本来就有一个真浏览器,不用再造一个残缺的**。
 *
 * ## 安全
 *
 * 打开的是**不受信任的任意网页**,所以窗口按最严的来配:不给 node、开沙箱、
 * 开上下文隔离、禁 webview 和弹窗。取内容走 executeJavaScript,注入的脚本
 * 只读 DOM,不引入任何外部代码。
 */

/** 单页最长等待。慢站不该把整轮对话拖死 */
const PAGE_TIMEOUT_MS = 20_000
/** 加载完之后再等一会,给 JS 渲染留时间 */
const SETTLE_MS = 600
/**
 * 页内脚本(注入 + 取值)的单步超时。
 *
 * loadURL 一直有超时,但之前 executeJavaScript 没有——页面 JS 只要卡住
 * (死循环、提取脚本 await 一个永不 resolve 的 Promise),整个工具调用就
 * 无限挂起,表现为"fetch 一个网页一直没反应"。取值脚本要跑 defuddle,
 * 给宽一点。
 */
const EXEC_TIMEOUT_MS = 15_000

export interface RenderedPage {
  url: string
  title: string
  /** 页面正文。defuddle 走通时是 markdown,兜底时是纯文本 */
  text: string
  author?: string
  published?: string
  /** 'defuddle' | 'fallback',排查提取质量时有用 */
  via?: string
}

/**
 * 打开一个页面并用注入脚本取值。
 *
 * 每次都新建、用完即毁:复用窗口能省几百毫秒,但会把上一个站点的 cookie、
 * localStorage、内存态带到下一个站点,不值得。
 */
export async function withPage<T>(
  url: string,
  extract: string,
  options: { timeout?: number; settle?: number; inject?: string[] } = {}
): Promise<T> {
  const { BrowserWindow } = await import('electron')

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
      // 图片对取正文没用,但很多站点会因为图片加载不完而拖长 did-finish-load
      images: false
    }
  })
  // 页面自己开的新窗口一律拒绝——一次抓取只应该产生一次导航
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  try {
    await withTimeout(win.loadURL(url), options.timeout ?? PAGE_TIMEOUT_MS, `打开超时:${url}`)
    await delay(options.settle ?? SETTLE_MS)
    // 依赖脚本先注入(如 defuddle),再跑取值脚本。每一步都带超时:
    // 超时后 finally 里 destroy 会直接杀掉渲染进程,挂着的脚本一并回收
    for (const source of options.inject ?? []) {
      await withTimeout(
        win.webContents.executeJavaScript(source, true),
        EXEC_TIMEOUT_MS,
        `页面脚本注入超时:${url}`
      )
    }
    return (await withTimeout(
      win.webContents.executeJavaScript(extract, true),
      EXEC_TIMEOUT_MS,
      `正文提取超时:${url}`
    )) as T
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })
  ])
}
