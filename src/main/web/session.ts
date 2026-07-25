import type { BrowserWindow } from 'electron'
import { buildSnapshot } from './snapshot'
import type { Snapshot } from './snapshot'

/**
 * 可交互的浏览器会话:一个常驻的无头窗口 + 一条 CDP 连接。
 *
 * ## 为什么不像 web_fetch 那样用完即毁
 *
 * 抓一个页面是一次性的,点击是**多步**的:搜结果 → 点进去 → 填表单 → 提交。
 * 每步都换窗口的话,登录态、cookie、滚动位置、SPA 的内存状态全丢,第二步
 * 就走不下去。所以按 streamId 存一个,整轮对话共用,轮次结束时销毁。
 *
 * ## 为什么用 CDP 而不是注入脚本
 *
 * 1. `Accessibility.getFullAXTree` **能穿透 shadow DOM**。注入的 querySelectorAll
 *    永远看不见闭合的 shadow root,而现在的组件库大量用它
 * 2. `Input.dispatchMouseEvent` 派发的是**可信事件**。`element.click()` 派发的
 *    是 untrusted 事件,不少框架和风控会直接忽略
 * 3. 不往页面里塞任何东西,不改 DOM,页面不知道自己被自动化了
 *
 * ## 安全
 *
 * 打开的是任意外部网页,窗口按最严配置:不给 node、开沙箱、开上下文隔离、
 * 禁止页面自己开新窗口。
 */

/** 页面动作后等待重绘/导航的时间。太短会拿到旧快照 */
const SETTLE_MS = 700
const NAV_TIMEOUT_MS = 25_000

export class BrowserSession {
  private win: BrowserWindow | null = null
  /** uid → CDP 的 backendNodeId。每次快照重建 */
  private refs = new Map<string, number>()

  private async ensure(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) return this.win

    const { BrowserWindow: BW } = await import('electron')
    const win = new BW({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        offscreen: true,
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webviewTag: false
      }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('DOM.enable')
    await win.webContents.debugger.sendCommand('Accessibility.enable')

    this.win = win
    return win
  }

  private async send<T = unknown>(method: string, params?: object): Promise<T> {
    const win = await this.ensure()
    return (await win.webContents.debugger.sendCommand(method, params)) as T
  }

  async open(url: string): Promise<Snapshot> {
    const win = await this.ensure()
    await withTimeout(win.loadURL(url), NAV_TIMEOUT_MS, `打开超时:${url}`)
    return this.snapshot()
  }

  /**
   * 取当前页面的无障碍树快照。
   *
   * **每次都重建 refs**。这是引用失效(stale ref)这个头号故障模式的解法:
   * 页面一重渲染,旧编号指向的元素就可能已经不存在,或者变成了另一个东西。
   * 与其维护失效检测,不如让每次动作都自带新快照——模型永远看的是当下。
   */
  async snapshot(): Promise<Snapshot> {
    const { nodes } = await this.send<{ nodes: AXNode[] }>('Accessibility.getFullAXTree')
    const win = await this.ensure()
    const built = buildSnapshot(nodes, {
      url: win.webContents.getURL(),
      title: win.webContents.getTitle()
    })
    this.refs = built.refs
    return built
  }

  /** 解析引用。失效时抛人话,而不是让后续动作打到错误的元素上 */
  private resolve(uid: string): number {
    const backendNodeId = this.refs.get(uid)
    if (backendNodeId === undefined) {
      throw new Error(
        `引用 ${uid} 不存在或已失效(页面可能重新渲染过)。先 browser_snapshot 取最新快照再操作。`
      )
    }
    return backendNodeId
  }

  async click(uid: string): Promise<void> {
    const backendNodeId = this.resolve(uid)
    const box = await this.send<{ model?: { content: number[] } }>('DOM.getBoxModel', {
      backendNodeId
    })
    if (!box.model) throw new Error(`${uid} 当前不可见(可能在折叠区域里),没法点击。`)

    // content 是 [x1,y1, x2,y2, x3,y3, x4,y4] 四个角,取对角线中点
    const [x1, y1, , , x3, y3] = box.model.content
    const x = Math.round((x1 + x3) / 2)
    const y = Math.round((y1 + y3) / 2)

    for (const type of ['mousePressed', 'mouseReleased'] as const) {
      await this.send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        clickCount: 1
      })
    }
    await delay(SETTLE_MS)
  }

  async fill(uid: string, value: string): Promise<void> {
    const backendNodeId = this.resolve(uid)
    await this.send('DOM.focus', { backendNodeId })
    // 先全选再输入,等价于"覆盖"而不是"追加"——模型填表单时几乎总是想要覆盖
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers: process.platform === 'darwin' ? 4 : 2, // Meta : Ctrl
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65
    })
    await this.send('Input.insertText', { text: value })
  }

  async press(key: string): Promise<void> {
    const meta = KEYS[key]
    if (!meta) throw new Error(`不支持的按键:${key}。可用:${Object.keys(KEYS).join('、')}`)
    for (const type of ['keyDown', 'keyUp'] as const) {
      await this.send('Input.dispatchKeyEvent', { type, ...meta })
    }
    await delay(SETTLE_MS)
  }

  async scroll(delta: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: 640,
      y: 450,
      deltaX: 0,
      deltaY: delta
    })
    await delay(300)
  }

  close(): void {
    if (!this.win || this.win.isDestroyed()) return
    // detach 要在 destroy 之前,否则 Electron 会在控制台留一条噪音
    try {
      if (this.win.webContents.debugger.isAttached()) this.win.webContents.debugger.detach()
    } catch {
      // 已经断开就算了
    }
    this.win.destroy()
    this.win = null
    this.refs.clear()
  }
}

/** CDP 的按键描述。只放常用的,乱传一个键位码不会报错但也不会有反应 */
const KEYS: Record<string, object> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }
}

export interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  description?: { value?: string }
  value?: { value?: string }
  properties?: { name: string; value?: { value?: unknown } }[]
  childIds?: string[]
  backendDOMNodeId?: number
}

/* ------------------------------------------------------------------ */
/* 会话池                                                              */
/* ------------------------------------------------------------------ */

const sessions = new Map<string, BrowserSession>()

export function browserSession(streamId: string): BrowserSession {
  let session = sessions.get(streamId)
  if (!session) {
    session = new BrowserSession()
    sessions.set(streamId, session)
  }
  return session
}

/**
 * 轮次结束时调用。
 *
 * 必须调:无头窗口不会自己消失,漏一次就常驻一个隐藏的 Chromium 渲染进程,
 * 用户只会看到内存莫名其妙涨上去。
 */
export function closeBrowserSession(streamId: string): void {
  sessions.get(streamId)?.close()
  sessions.delete(streamId)
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
