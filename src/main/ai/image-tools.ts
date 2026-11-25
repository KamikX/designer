import { localizedTools } from '../i18n'
import { aiText } from '../i18n'
import { promptText } from './prompts/i18n'
import type { PromptLanguage } from './prompts/i18n'
import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { resolveAsset } from '../storage/service'
import { contentAwareModelOutput } from './tool-result'
import { VfsError } from './vfs-error'

/**
 * 参考图工具。
 *
 * ## 为什么图片不常驻上下文
 *
 * 图片按**像素尺寸**计费,一张 1000×1000 大约一千多 token。如果每轮都把
 * 它塞进历史,就是每轮重付一次——而多数后续轮次(改个颜色、调个间距)
 * 压根用不着看图。
 *
 * 所以做成:发出它的那一轮正常带图,之后历史里只留引用和一句 description,
 * 模型真需要像素了自己用 view_image 拉回来。和文件那套"先搜再读、按需
 * 加载"是同一个原则,只是换了介质。
 *
 * ## description 是"记忆"
 *
 * note_image 让模型看过图之后用一句话记下要点。有了它,多数后续轮次连
 * view_image 都不用调——这是省得最彻底的一种省法。
 */

/** 描述过长就失去意义了:它存在的理由就是比图片便宜 */
const MAX_NOTE_CHARS = 300

export interface ImageToolContext {
  /**
   * 本会话出现过的参考图。**只认这个白名单**——不能让模型拿任意
   * asset id 来试探,那等于开了一个读任意资源的口子。
   */
  assets: { assetId: string; name: string; description?: string }[]
  /** 写回 description,由 chat-service 落到对应消息的 image part 上 */
  onNote: (assetId: string, description: string) => void
}

export function buildImageTools(
  context: ImageToolContext,
  lang: PromptLanguage = 'zh-CN'
): ToolSet {
  const known = (assetId: string): { assetId: string; name: string } => {
    const hit = context.assets.find((a) => a.assetId === assetId)
    if (!hit) {
      const list = context.assets.map((a) => `${a.assetId}(${a.name})`).join('、')
      throw new VfsError(
        list
          ? aiText('ai.imageTools.thatReferenceImageIsNotAvailableImagesInThisConversation', list)
          : aiText('ai.imageTools.theUserHasNotProvidedReferenceImagesInThisConversation')
      )
    }
    return hit
  }

  const tools = {
    view_image: tool({
      description: promptText(lang, 'tools.view_image.description'),
      inputSchema: z.object({
        asset_id: z.string().describe(promptText(lang, 'tools.view_image.parameters.asset_id'))
      }),
      execute: async ({ asset_id }) => {
        let hit: { assetId: string; name: string }
        try {
          hit = known(asset_id)
        } catch (err) {
          return err instanceof VfsError
            ? aiText('ai.imageTools.error', err.message)
            : aiText('ai.imageTools.error', String(err))
        }

        const resolved = await resolveAsset(hit.assetId)
        if (!resolved) {
          return aiText('ai.imageTools.errorReferenceImageIsNoLonger', hit.name)
        }

        // 工具结果可以直接携带图片,但要经 toModelOutput 才作数(见下)
        return {
          type: 'content' as const,
          value: [
            { type: 'text' as const, text: aiText('ai.imageTools.referenceImage', hit.name) },
            {
              type: 'file' as const,
              data: { type: 'data' as const, data: resolved.data },
              mediaType: resolved.mime
            }
          ]
        }
      },
      toModelOutput: contentAwareModelOutput
    }),

    note_image: tool({
      description: promptText(lang, 'tools.note_image.description'),
      inputSchema: z.object({
        asset_id: z.string(),
        description: z
          .string()
          .max(MAX_NOTE_CHARS)
          .describe(promptText(lang, 'tools.note_image.parameters.description'))
      }),
      execute: async ({ asset_id, description }) => {
        try {
          const hit = known(asset_id)
          context.onNote(hit.assetId, description.trim())
          return aiText('ai.imageTools.savedTheDescriptionOfItWillBeIncludedInLaterTurns', hit.name)
        } catch (err) {
          return err instanceof VfsError
            ? aiText('ai.imageTools.error', err.message)
            : aiText('ai.imageTools.error', String(err))
        }
      }
    })
  }
  return localizedTools(tools, lang)
}
