import { BrowserWindow } from 'electron'

/**
 * 预览的离屏截图:给模型的"眼睛"。
 *
 * ## 为什么必须有
 *
 * 在这之前,模型对自己产出的**视觉结果**是全盲的——层级失衡、间距混乱、模板脸,
 * 这些只有看渲染结果才能发现的问题,一律要等用户开口。截图 + 多模态自审是把
 * "写完就交"变成"看过再交"的那一步,也是和纯提示词方案最大的结构差距。
 *
 * ## 实现取舍
 *
 * - 每次新建隐藏 BrowserWindow、用完销毁:截图在一轮里最多几次,窗口池不值得
 * - 就绪信号复用 bootstrap 的 ready postMessage:顶层窗口里 parent === window,
 *   消息会派发给自己;dom-ready 时装监听——它早于 load,更早于 ready 的双层 rAF,
 *   不会漏
 * - 出错(编译 throw / 运行时异常)不放弃截图:白屏本身就是要给模型看的事实,
 *   错误文本一并带回
 */

export interface CaptureResult {
  png: Buffer
  /** 页面里冒出的运行时/编译错误,没有则为 null */
  error: string | null
  /** 是否等到了挂载完成信号;false 表示超时硬拍 */
  ready: boolean
}

/** 挂载信号的等待上限。超时不算失败——硬拍一张,白屏也是信息 */
const READY_TIMEOUT_MS = 6000
/** ready 之后再等一拍:图片解码、字体应用这类"就绪之后"的最后一帧 */
const SETTLE_MS = 250

const LISTENER = `
  (function () {
    window.__antdCapture = { ready: false, error: null };
    window.addEventListener('message', function (e) {
      var d = e && e.data;
      if (!d || !d.__preview) return;
      if (d.type === 'ready') window.__antdCapture.ready = true;
      if (d.type === 'error' && !window.__antdCapture.error)
        window.__antdCapture.error = String(d.message);
    });
  })();
  true
`

export async function capturePreview(
  url: string,
  viewport: { width: number; height: number }
): Promise<CaptureResult> {
  const win = new BrowserWindow({
    show: false,
    width: viewport.width,
    height: viewport.height,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      // 预览内容是模型生成的任意代码,和 iframe 预览同等对待:不给任何 Node 能力
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  try {
    win.webContents.setAudioMuted(true)
    win.webContents.on('dom-ready', () => {
      // dom-ready 早于 load,而 ready 信号在 load 之后还要过双层 rAF,装得上
      void win.webContents.executeJavaScript(LISTENER).catch(() => {})
    })

    await win.loadURL(url)

    const state = await waitForReady(win)
    await sleep(SETTLE_MS)

    const image = await win.webContents.capturePage()
    return { png: image.toPNG(), error: state.error, ready: state.ready }
  } finally {
    win.destroy()
  }
}

async function waitForReady(win: BrowserWindow): Promise<{ ready: boolean; error: string | null }> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  let error: string | null = null
  while (Date.now() < deadline) {
    try {
      const state = (await win.webContents.executeJavaScript('window.__antdCapture')) as {
        ready: boolean
        error: string | null
      } | null
      if (state?.error) error = state.error
      // 出错后页面不会再发 ready;拿到错误就别等满超时了
      if (state?.ready || state?.error) return { ready: !!state.ready, error }
    } catch {
      // executeJavaScript 在导航间隙可能失败,下一轮再试
    }
    await sleep(100)
  }
  return { ready: false, error }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
