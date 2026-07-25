import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import { resolveAsset } from '../storage/service'
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

export function buildImageTools(context: ImageToolContext): ToolSet {
  const known = (assetId: string): { assetId: string; name: string } => {
    const hit = context.assets.find((a) => a.assetId === assetId)
    if (!hit) {
      const list = context.assets.map((a) => `${a.assetId}(${a.name})`).join('、')
      throw new VfsError(
        list ? `没有这张参考图。本次会话可用的是:${list}` : '本次会话里用户没有提供过参考图。'
      )
    }
    return hit
  }

  const tools = {
    view_image: tool({
      description:
        '重新查看用户提供过的参考图。历史里只保留了图片的引用和一句描述,' +
        '**需要看具体像素时**(取准确的颜色、看清某个组件的形状与间距)才调它。' +
        '如果描述已经够回答当前问题,就不要调——图片按尺寸计费,不便宜。',
      inputSchema: z.object({
        asset_id: z.string().describe('历史里给出的参考图 id')
      }),
      execute: async ({ asset_id }) => {
        let hit: { assetId: string; name: string }
        try {
          hit = known(asset_id)
        } catch (err) {
          return err instanceof VfsError ? `错误:${err.message}` : `错误:${String(err)}`
        }

        const resolved = await resolveAsset(hit.assetId)
        if (!resolved) {
          return `错误:参考图 ${hit.name} 的文件已经取不到了(可能是存储配置变了)。`
        }

        // 工具结果可以直接携带图片:AI SDK 会把它转成对应供应商的图片块
        return {
          type: 'content' as const,
          value: [
            { type: 'text' as const, text: `参考图 ${hit.name}:` },
            {
              type: 'file' as const,
              data: { type: 'data' as const, data: resolved.data },
              mediaType: resolved.mime
            }
          ]
        }
      }
    }),

    note_image: tool({
      description:
        '看过参考图之后,用一两句话把它的要点记下来(配色、布局特征、气质),' +
        '之后的轮次靠这句描述就够用,不必反复调 view_image 看图。' +
        '写具体些——"深色底、大量留白、卡片圆角很大、主色偏冷蓝紫"比"很现代"有用得多。',
      inputSchema: z.object({
        asset_id: z.string(),
        description: z.string().max(MAX_NOTE_CHARS).describe('一两句话,写特征不写感受')
      }),
      execute: async ({ asset_id, description }) => {
        try {
          const hit = known(asset_id)
          context.onNote(hit.assetId, description.trim())
          return `已记下 ${hit.name} 的描述,后续轮次会带上它。`
        } catch (err) {
          return err instanceof VfsError ? `错误:${err.message}` : `错误:${String(err)}`
        }
      }
    })
  }
  return tools
}
