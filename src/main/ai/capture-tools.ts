import { localizedTools } from '../i18n'
import { aiText } from '../i18n'
import { promptText } from './prompts/i18n'
import type { PromptLanguage } from './prompts/i18n'
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

export function buildCaptureTools(
  context: CaptureToolContext,
  lang: PromptLanguage = 'zh-CN'
): ToolSet {
  // 懒加载:preview/capture 依赖 electron 的 BrowserWindow,提前 import 会把
  // 纯 node 环境的测试拖下水;截图真发生时 electron 一定在
  const capture =
    context.capture ??
    (async (url: string, viewport: { width: number; height: number }) =>
      (await import('../preview/capture')).capturePreview(url, viewport))

  return localizedTools(
    {
      capture_preview: tool({
        description: promptText(lang, 'tools.capture_preview.description'),
        inputSchema: z.object({
          path: z
            .string()
            .optional()
            .describe(promptText(lang, 'tools.capture_preview.parameters.path')),
          viewport: z
            .enum(['desktop', 'mobile'])
            .optional()
            .describe(promptText(lang, 'tools.capture_preview.parameters.viewport'))
        }),
        execute: async (input) => {
          if (!context.hasFiles()) return aiText('ai.captureTools.theDesignHasNoFilesToCaptureYet')

          const viewport = VIEWPORTS[input.viewport ?? 'desktop']
          const target = input.path ? encodeURI(input.path) : ''
          const url = `preview://session/${context.sessionId}/${target}`
          try {
            const result = await capture(url, viewport)
            const notes: string[] = []
            if (result.error)
              notes.push(aiText('ai.captureTools.warningThePageReportedAnError', result.error))
            else if (!result.ready)
              notes.push(
                aiText('ai.captureTools.warningCapturedAfterTheMountTimedOutThePageMayBeIncomplete')
              )
            return {
              type: 'content' as const,
              value: [
                {
                  type: 'text' as const,
                  text:
                    aiText(
                      'ai.captureTools.theCurrentDesignRenderedInAViewport',
                      viewport.width,
                      viewport.height
                    ) + (notes.length ? `\n${notes.join('\n')}` : '')
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
            return aiText(
              'ai.captureTools.errorScreenshotFailedContinueEditingUseReadFileToInspectFilesIf',
              detail
            )
          }
        },
        toModelOutput: contentAwareModelOutput
      })
    },
    lang
  )
}
