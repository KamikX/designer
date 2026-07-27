import { defineStore } from 'pinia'

/**
 * 预览标注:用户在预览里点中元素、写一句备注,随下一条消息交给模型。
 *
 * ## 为什么是"随下一条消息"而不是常驻
 *
 * 标注是"我现在想改这里"的即时意图,和参考图、本轮附带的本地文件是同一类
 * 东西——发出去就完事了。做成常驻清单的话,上周标的东西会一直跟着每一轮
 * 重发,而那时元素早就不在了。
 *
 * ## 为什么绑 artifactId
 *
 * 和预览报错(main/preview/errors.ts)、lint 结果同一条纪律:标记是对**某个
 * 版本**的元素做的,版本一换(切版本、AI 出了新版)旧标记就不该再算数——
 * 拿 v3 的坐标去改 v4 是纯粹的误导。
 */

/** 元素签名,由 iframe 里的标注运行时计算(见 main/preview/annotate-runtime.ts) */
export interface MarkTarget {
  /** vue3 编译期注入的 `文件:行:列`;html / react 为空串 */
  source: string
  tag: string
  id: string
  classes: string[]
  text: string
  /** 祖先链,如 `div.card > form > button` */
  path: string
  attrs: Record<string, string>
  /** outerHTML 片段(过长时退化成开标签) */
  html: string
  /** querySelector 能吃回去的路径,徽标复原与去重都靠它 */
  selector: string
  rect: { x: number; y: number; w: number; h: number }
}

export interface PreviewMark {
  id: string
  /** 展示用的序号,从 1 开始;删一条之后会重排 */
  index: number
  note: string
  target: MarkTarget
}

/**
 * 标记数上限。再多就不是"指几处改"而是"重做一版"了,而且每一条都要占
 * 消息正文的篇幅。
 */
export const MAX_MARKS = 20

export const useAnnotationStore = defineStore('annotation', {
  state: () => ({
    /** 标注模式开关(预览面板的按钮) */
    enabled: false,
    /** 这些标记是在哪个版本上标的 */
    artifactId: '',
    marks: [] as PreviewMark[]
  }),

  actions: {
    /** 版本变了就整体作废。相同版本重复调用是幂等的,可以放心在 watch 里用 */
    syncArtifact(artifactId: string): void {
      if (this.artifactId === artifactId) return
      this.artifactId = artifactId
      this.marks = []
      this.enabled = false
    },

    add(target: MarkTarget, note: string): PreviewMark | null {
      if (this.marks.length >= MAX_MARKS) return null
      const mark: PreviewMark = {
        id: `${Date.now().toString(36)}-${this.marks.length}`,
        index: this.marks.length + 1,
        note: note.trim(),
        target
      }
      this.marks.push(mark)
      return mark
    },

    remove(id: string): void {
      this.marks = this.marks.filter((m) => m.id !== id)
      // 序号连续才对得上正文里的 [1] [2],删中间一条要重排
      this.marks.forEach((m, i) => (m.index = i + 1))
    },

    clear(): void {
      this.marks = []
    }
  }
})
