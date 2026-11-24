import { promptText } from './prompts/i18n'
import type { PromptLanguage } from './prompts/i18n'
import { statSync } from 'fs'
import { relative, sep } from 'path'
import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import type { WorkspaceRoot } from '../../shared/types'
import { displayPath, resolveWithin } from '../workspace/roots'
import { extractDocument, isSupportedDocument } from '../workspace/documents'
import {
  canExtractImages,
  extractEmbeddedImages,
  MAX_IMAGES,
  renderPdfPages
} from '../workspace/doc-images'
import type { DocImage } from '../workspace/doc-images'
import { condenseIfLong } from './assistant'
import { contentAwareModelOutput } from './tool-result'
import type { ContentToolOutput } from './tool-result'
import {
  grep,
  isBinaryPath,
  probeReadable,
  readTextRange,
  walk,
  globToRegExp,
  LIMITS
} from '../workspace/scan'

/**
 * 本地工作区工具:让 AI 读用户真实的项目和文档,照着做设计稿。
 *
 * ## 权限模型
 *
 * 只在用户为本项目授权过目录时才注册——**没授权就没有工具**,模型连一个
 * 可以试探的入口都看不到。每个路径参数都过 resolveWithin:realpath 之后
 * 判断是否落在授权子树里,软链绕出去也会被挡。
 *
 * ## 为什么不给"执行系统命令"
 *
 * 用户提到了"调用一些常用的系统命令"。实际需要的能力是 ls / find / grep /
 * cat 这四件事,下面四个工具都覆盖了,而且更好:
 *
 * - 跨平台一致(不用管 Windows 上没有 grep)
 * - 输出是结构化的,不用解析千奇百怪的命令输出
 * - 有硬上限,不会因为在根目录跑一次 find 就卡死
 * - **没有任意代码执行面**。开一个 shell 通道,等于把 RCE 的风险押在
 *   "模型不会写出危险命令"上,这个赌注不值得下
 *
 * 真需要跑构建、跑测试时再单独设计带确认的通道,那是另一个话题。
 */

/** 与文件工具一致:结果会随每一步重发,必须有上限 */
const MAX_RESULT_CHARS = 12000

async function guarded(run: () => string | Promise<string>): Promise<string> {
  try {
    const out = await run()
    return out.length <= MAX_RESULT_CHARS
      ? out
      : `${out.slice(0, MAX_RESULT_CHARS)}\n\n…结果过长已截断,请缩小范围。`
  } catch (err) {
    return `错误:${err instanceof Error ? err.message : String(err)}`
  }
}

export interface LocalToolOptions {
  /**
   * 当前模型有没有识图能力。
   *
   * 决定两件事:扫描件 PDF 能不能改走渲染成图片这条路,以及要不要注册
   * read_document_images。没有识图能力时给图毫无意义,还会让供应商直接报错。
   */
  canSeeImages: boolean
  /** 用户这轮的诉求,提炼长文档时当线索用 */
  intent?: string
}

export function buildLocalTools(
  roots: WorkspaceRoot[],
  options: LocalToolOptions = { canSeeImages: false },
  lang: PromptLanguage = 'zh-CN'
): ToolSet {
  if (roots.length === 0) return {}

  const scope = roots.map((r) => `${r.name}(${r.path})`).join('、')
  const show = (absolute: string): string => displayPath(roots, absolute)

  const tools = {
    list_local_dir: tool({
      description: promptText(lang, 'tools.list_local_dir.description', { scope: scope }),
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe(promptText(lang, 'tools.list_local_dir.parameters.path')),
        depth: z
          .number()
          .int()
          .min(0)
          .max(6)
          .optional()
          .describe(promptText(lang, 'tools.list_local_dir.parameters.depth'))
      }),
      execute: async (input) =>
        guarded(() => {
          const base = resolveWithin(roots, input.path ?? roots[0].name)
          // 用户在对话里直接给一个文件路径时,授权的就是那一个文件
          if (!statSync(base).isDirectory()) {
            return `${show(base)} 是一个文件(${formatSize(statSync(base).size)}),不是目录。用 read_local_file 或 read_local_document 读它。`
          }
          const entries = walk(base, { maxDepth: input.depth ?? 2 })
          if (entries.length === 0) return `${show(base)} 是空目录。`
          const lines = entries.slice(0, LIMITS.results).map((e) => {
            const indent = '  '.repeat(e.rel.split(sep).length - 1)
            const name = e.rel.split(sep).pop()
            return e.isDir ? `${indent}${name}/` : `${indent}${name}\t${formatSize(e.size)}`
          })
          const more =
            entries.length > LIMITS.results ? `\n…还有 ${entries.length - LIMITS.results} 项` : ''
          return `${show(base)}:\n${lines.join('\n')}${more}`
        })
    }),

    check_local_path: tool({
      description: promptText(lang, 'tools.check_local_path.description'),
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) =>
        guarded(() => {
          let target: string
          try {
            target = resolveWithin(roots, path)
          } catch {
            // 范围之外一律给同一句话,**不透露它到底存不存在**。
            // 否则这个工具就成了探测本机文件系统的入口:模型被诱导着
            // 逐个试 ~/.ssh/id_rsa 之类的路径,靠"存在/不存在"就能摸出
            // 一份目录结构
            return `${path}:不在授权范围内,看不到。请让用户把这个路径发到对话里,或在界面上授权对应目录。`
          }

          const stat = statSync(target)
          if (stat.isDirectory()) {
            const children = walk(target, { maxDepth: 0 })
            return `${show(target)}:目录,直接子项 ${children.length} 个。可以用 list_local_dir 展开。`
          }
          // 判定顺序必须和 read_local_file 完全一致,否则两个工具会给出
          // 互相矛盾的答案:先看后缀(对已知类型它是权威的——.png 就是 PNG,
          // 哪怕内容碰巧像文本),再落到内容嗅探
          if (isBinaryPath(target)) {
            return isSupportedDocument(target)
              ? `${show(target)}:文件,${formatSize(stat.size)},文档格式,用 read_local_document 读。`
              : `${show(target)}:文件,${formatSize(stat.size)},二进制,读不了。`
          }
          // 后缀不在黑名单里也不代表就是文本,还要按内容验一次
          const probe = probeReadable(target)
          if (!probe.ok) {
            // 后缀说谎的情况:一个叫 notes.txt 的 PDF,该引导去文档工具
            // 而不是简单地拒绝
            const hint = probe.isDocument ? ' 但它其实是文档,用 read_local_document 读。' : ''
            return `${show(target)}:文件,${formatSize(stat.size)},读不了——${probe.reason}${hint}`
          }
          return `${show(target)}:文件,${formatSize(stat.size)},可以当文本读(read_local_file)。`
        })
    }),

    find_local_files: tool({
      description: promptText(lang, 'tools.find_local_files.description'),
      inputSchema: z.object({
        glob: z.string().describe(promptText(lang, 'tools.find_local_files.parameters.glob')),
        path: z
          .string()
          .optional()
          .describe(promptText(lang, 'tools.find_local_files.parameters.path'))
      }),
      execute: async (input) =>
        guarded(() => {
          const base = resolveWithin(roots, input.path ?? roots[0].name)
          const match = globToRegExp(input.glob)
          const hits = walk(base)
            .filter((e) => !e.isDir && match.test(e.rel.split(sep).join('/')))
            .slice(0, LIMITS.results)
          if (hits.length === 0) return `没有匹配 ${input.glob} 的文件。`
          return hits.map((e) => `${show(e.path)}\t${formatSize(e.size)}`).join('\n')
        })
    }),

    search_local: tool({
      description: promptText(lang, 'tools.search_local.description'),
      inputSchema: z.object({
        query: z.string(),
        is_regex: z.boolean().optional(),
        glob: z
          .string()
          .optional()
          .describe(promptText(lang, 'tools.search_local.parameters.glob')),
        path: z.string().optional(),
        max_results: z.number().int().min(1).max(200).optional()
      }),
      execute: async (input) =>
        guarded(() => {
          const base = resolveWithin(roots, input.path ?? roots[0].name)
          let pattern: RegExp
          try {
            pattern = new RegExp(
              input.is_regex ? input.query : input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
              'gi'
            )
          } catch (err) {
            throw new Error(`正则无效:${err instanceof Error ? err.message : String(err)}`)
          }
          const hits = grep(base, pattern, { glob: input.glob, maxResults: input.max_results })
          if (hits.length === 0) return '没有匹配。可以放宽关键词或换个 glob。'
          return `${hits.length} 处匹配:\n${hits
            .map((h) => `${show(h.path)}:${h.line}:${h.column}: ${h.text}`)
            .join('\n')}`
        })
    }),

    read_local_file: tool({
      description: promptText(lang, 'tools.read_local_file.description', {
        maxLines: LIMITS.readLines
      }),
      inputSchema: z.object({
        path: z.string(),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional()
      }),
      execute: async (input) =>
        guarded(() => {
          const file = resolveWithin(roots, input.path)
          if (statSync(file).isDirectory()) throw new Error('这是目录,用 list_local_dir。')
          if (isBinaryPath(file)) {
            throw new Error(
              isSupportedDocument(file)
                ? '这是文档格式,请用 read_local_document 读。'
                : '这是二进制文件,读不了。'
            )
          }
          const { body, total, from, to } = readTextRange(file, input.start_line, input.end_line)
          const note =
            from > 1 || to < total
              ? `\n\n---\n${show(file)} 共 ${total} 行,当前看的是 ${from}-${to}。`
              : ''
          return body + note
        })
    }),

    read_local_document: tool({
      description: promptText(lang, 'tools.read_local_document.description'),
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        let file: string
        try {
          file = resolveWithin(roots, path)
        } catch (err) {
          return `错误:${err instanceof Error ? err.message : String(err)}`
        }

        let doc: Awaited<ReturnType<typeof extractDocument>>
        try {
          doc = await extractDocument(file)
        } catch (err) {
          return `错误:${err instanceof Error ? err.message : String(err)}`
        }

        // 抽出来的是空白或乱码——扫描件和字体坏掉的 PDF 都属于这种,
        // 而且它们**不会报错**。把垃圾交出去,模型会拿着它一本正经地推理
        if (!doc.verdict.usable) {
          if (!options.canSeeImages) {
            return (
              `${show(file)} 读不出可用文字:${doc.verdict.reason}\n` +
              '当前模型不支持识图,没法改用图片方式。请让用户换一个带识图能力的模型,' +
              '或者提供这份文档的文字版。'
            )
          }
          if (!canExtractImages(file)) {
            return `${show(file)} 读不出可用文字:${doc.verdict.reason}`
          }
          // 走到这里说明文字指望不上了,只能靠图看懂——这时才值得付
          // Electron 渲染那几百毫秒换字体正确
          const rendered = await imagesOf(file, 1, MAX_IMAGES, true)
          if (rendered.images.length === 0) {
            return `${show(file)} 读不出可用文字:${doc.verdict.reason}(也取不到可用的图片)`
          }

          // 抽取失败常常是字体坏,而**渲染用的是同一套字体**——图很可能同样
          // 是空白或乱码,我们这边判断不了(那需要 OCR)。唯一能判断的是拿到
          // 图的模型自己,所以明确要求它先验一眼,不可读就停,别硬猜。
          // 这条是这个功能最后一道防线:宁可承认读不了,也不能编。
          const salvaged = salvageReadable(doc.text)
          return asContent(
            [
              `${show(file)} 抽不出可用文字(${doc.verdict.reason})`,
              `改用页面图片:共 ${rendered.total} ${rendered.unit},以下是前 ${rendered.images.length} 张。` +
                (rendered.total > rendered.images.length
                  ? ' 需要看后面的用 read_document_images 指定起始页。'
                  : ''),
              '',
              '**先确认图上是不是可读的文字**。如果图上也是乱码、空白或缺字,',
              '说明这份文档我们解析不了——直接告诉用户,请他提供其他格式(Word、',
              '文字版 PDF、或者截图),不要根据残缺内容猜测文档在讲什么。',
              ...(rendered.renderer === 'wasm'
                ? ['(这些图是用内置渲染器画的,对非嵌入的中文字体可能缺字)']
                : []),
              ...(salvaged ? ['', `另外,文字抽取里这部分是可读的,可以参考:\n${salvaged}`] : [])
            ].join('\n'),
            rendered.images
          )
        }

        // 长文档先用辅助模型压成设计要点,不然几万字直接吃掉半个上下文。
        // 压不了(没配 / 失败)就退回原文,读文档这件事本身不能被拖垮
        const condensed = await condenseIfLong(doc.text, options.intent)

        const imageHint =
          options.canSeeImages && canExtractImages(file)
            ? '\n\n(文档里若有配图,可用 read_document_images 查看)'
            : ''
        const notes = [doc.note, condensed.note].filter(Boolean).join(';')
        const banner = condensed.summarized
          ? `${show(file)}(${notes})\n**以下是提炼稿,不是原文**;需要某处的原文再单独问用户。\n\n`
          : `${show(file)}(${notes})\n\n`
        return capText(`${banner}${condensed.text}${imageHint}`)
      },
      // 上面"抽不出文字改用页面图"那条分支会返回图片
      toModelOutput: contentAwareModelOutput
    }),

    ...(options.canSeeImages
      ? {
          read_document_images: tool({
            description: promptText(lang, 'tools.read_document_images.description', {
              maxImages: MAX_IMAGES
            }),
            inputSchema: z.object({
              path: z.string(),
              from: z
                .number()
                .int()
                .min(1)
                .optional()
                .describe(promptText(lang, 'tools.read_document_images.parameters.from')),
              count: z.number().int().min(1).max(MAX_IMAGES).optional()
            }),
            execute: async (input) => {
              let file: string
              try {
                file = resolveWithin(roots, input.path)
              } catch (err) {
                return `错误:${err instanceof Error ? err.message : String(err)}`
              }
              if (!canExtractImages(file)) {
                return `错误:${show(file)} 这个类型取不了图(支持 pdf / docx / xlsx / pptx)。`
              }
              try {
                const out = await imagesOf(file, input.from ?? 1, input.count ?? MAX_IMAGES)
                if (out.images.length === 0) {
                  return `${show(file)} 里没有可取的图片(内嵌小图标已跳过)。`
                }
                return asContent(
                  `${show(file)}:共 ${out.total} ${out.unit},以下是第 ${input.from ?? 1} 张起的 ${out.images.length} 张。`,
                  out.images
                )
              } catch (err) {
                return `错误:取图失败——${err instanceof Error ? err.message : String(err)}`
              }
            },
            toModelOutput: contentAwareModelOutput
          })
        }
      : {})
  }
  return tools
}

/** pdf 走渲染,ooxml 走解压 */
async function imagesOf(
  file: string,
  from: number,
  count: number,
  highFidelity = false
): Promise<{ images: DocImage[]; total: number; unit: string; renderer?: string }> {
  if (file.toLowerCase().endsWith('.pdf')) {
    const out = await renderPdfPages(file, { from, count, highFidelity })
    return { images: out.images, total: out.totalPages, unit: '页', renderer: out.renderer }
  }
  const out = await extractEmbeddedImages(file, { from, count })
  return { images: out.images, total: out.total, unit: '张图' }
}

/** 组装成能直接携带图片的工具结果。交给模型要经 toModelOutput,见 tool-result.ts */
function asContent(text: string, images: DocImage[]): ContentToolOutput {
  return {
    type: 'content' as const,
    value: [
      { type: 'text' as const, text },
      ...images.flatMap((image) => [
        { type: 'text' as const, text: image.label },
        {
          type: 'file' as const,
          data: { type: 'data' as const, data: image.data },
          mediaType: image.mime
        }
      ])
    ]
  }
}

/**
 * 从整体判定为乱码的抽取结果里,把仍然可读的行捞出来。
 *
 * 混合字体的 PDF 很常见:一份文档里目录用 A 字体(能抽)、正文用 B 字体
 * (抽不出)。整份判定为乱码时如果连能读的部分一起丢掉,就把白拿的信息
 * 扔了——那份 202 页的文档,目录页恰好是完整可读的章节清单。
 *
 * 判据按行走:一行里可读字符(中日韩 / 字母 / 数字)够多才留。
 */
export function salvageReadable(text: string, maxChars = 1500): string {
  const kept: string[] = []
  let used = 0

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length < 4) continue

    let readable = 0
    for (const char of trimmed) {
      if (
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}a-zA-Z]/u.test(char)
      ) {
        readable++
      }
    }
    // 半数以上是真文字才算这行可用;页码分隔之类的短行上面已经滤掉
    if (readable * 2 < trimmed.length) continue

    // +1 是 join 时的换行符,不算进去会超出上限
    if (used + trimmed.length + 1 > maxChars) break
    kept.push(trimmed)
    used += trimmed.length + 1
  }
  return kept.join('\n')
}

function capText(text: string): string {
  return text.length <= MAX_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_RESULT_CHARS)}\n\n…结果过长已截断,请缩小范围。`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

/**
 * 给 system prompt 用的一段说明。
 *
 * missing 是本轮用户消息里"看着像路径、但那个东西不存在"的那些。必须告诉
 * 模型——否则用户打错一个字母,表现是 AI 装作没看见他提过这个文件,
 * 然后开始瞎猜。
 */
export function localScopePrompt(
  roots: WorkspaceRoot[],
  missing: string[] = [],
  lang: PromptLanguage = 'zh-CN'
): string {
  if (roots.length === 0 && missing.length === 0) return ''

  const typo = missing.length
    ? promptText(lang, 'scope.missingPaths', { paths: missing.map((p) => `- ${p}`).join('\n') })
    : ''

  if (roots.length === 0) {
    return promptText(lang, 'scope.unauthorized', { typo: typo })
  }

  // 标出哪些是单个文件:用户拖一份 pdf 进来时授权的就是那一个文件。
  // 不说清楚的话模型会对着它调 list_local_dir,白跑一步才知道不是目录
  const list = roots
    .map((r) => {
      let kind = ''
      try {
        kind = statSync(r.path).isFile() ? promptText(lang, 'scope.singleFile') : ''
      } catch {
        kind = promptText(lang, 'scope.nonexistent')
      }
      return `- ${r.name} → ${r.path} ${kind}`.trimEnd()
    })
    .join('\n')

  return promptText(lang, 'scope.authorized', { list: list, typo: typo }).trim()
}

/** 相对路径展示用,避免把用户的完整磁盘路径反复喂给模型 */
export function relativeToRoot(root: string, target: string): string {
  return relative(root, target)
}
