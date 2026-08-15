import { tool } from 'ai'
import { z } from 'zod'
import { contentAwareModelOutput } from './tool-result'
import type { ToolSet } from 'ai'
import type { CaptureResult } from '../preview/capture'

/**
 * capture_preview:模型给自己的产出拍一张渲染截图。
 *
 * 只在**多模态模型 + 设计会话**下注册:拍了看不见等于白拍。VFS 内容经
 * preview://session/<id>/ 直出,和用户预览走同一套编译——模型看到的就是
 * 用户将要看到的。
 */
export interface CaptureToolContext {
  /** chat-service 在 session-registry 里注册的预览源 id */
  sessionId: string
  hasFiles: () => boolean
  /** 测试注入口;缺省用真实的离屏窗口截图 */
  capture?: (url: string, viewport: { width: number; height: number }) => Promise<CaptureResult>
}

const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  mobile: { width: 390, height: 844 }
} as const

export function buildCaptureTools(context: CaptureToolContext): ToolSet {
  // 懒加载:preview/capture 依赖 electron 的 BrowserWindow,提前 import 会把
  // 纯 node 环境的测试拖下水;截图真发生时 electron 一定在
  const capture =
    context.capture ??
    (async (url: string, viewport: { width: number; height: number }) =>
      (await import('../preview/capture')).capturePreview(url, viewport))

  return {
    capture_preview: tool({
      description:
        '渲染当前设计稿并截图给你自己看。**写完或大改之后必须看一眼再交**:' +
        '层级失衡、间距混乱、模板脸,这些只有看渲染结果才能发现,交给用户去发现就晚了。' +
        '看完对照手艺底线的五维自评,发现问题当轮修掉。' +
        '移动端稿子传 viewport: "mobile"。图片按尺寸计费,同一版本看一次就够。',
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe('要看的页面文件路径,缺省为入口页(index.html / App 根)'),
        viewport: z
          .enum(['desktop', 'mobile'])
          .optional()
          .describe('视口尺寸,缺省 desktop(1280×800);mobile 是 390×844')
      }),
      execute: async (input) => {
        if (!context.hasFiles()) return '设计稿还没有任何文件,没什么可截图的。'

        const viewport = VIEWPORTS[input.viewport ?? 'desktop']
        const target = input.path ? encodeURI(input.path) : ''
        const url = `preview://session/${context.sessionId}/${target}`
        try {
          const result = await capture(url, viewport)
          const notes: string[] = []
          if (result.error) notes.push(`注意:页面报错了——${result.error}`)
          else if (!result.ready) notes.push('注意:等挂载超时后硬拍的,可能是半成品状态。')
          return {
            type: 'content' as const,
            value: [
              {
                type: 'text' as const,
                text:
                  `当前设计稿在 ${viewport.width}×${viewport.height} 视口的渲染截图。` +
                  (notes.length ? `\n${notes.join('\n')}` : '')
              },
              {
                type: 'file' as const,
                data: { type: 'data' as const, data: result.png },
                mediaType: 'image/png'
              }
            ]
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          return `错误:截图失败(${detail})。不影响继续编辑文件,必要时靠 read_file 自查。`
        }
      },
      toModelOutput: contentAwareModelOutput
    })
  }
}
