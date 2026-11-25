import { localizedTools } from '../i18n'
import { aiText } from '../i18n'
import { promptText } from './prompts/i18n'
import type { PromptLanguage } from './prompts/i18n'
import { tool } from 'ai'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import type { AskUserAnswer, AskUserInput, Project } from '../../shared/types'
import type { FileStreamParser } from './file-stream-parser'
import { SessionVfs } from './session-vfs'

export interface StyleFallback {
  color: string
  brightness: string
  density: string
  geometry: string
  surface: string
  navigation: string
}

export type StyleBriefPromptMode = 'tools' | 'markers'

export interface StyleBriefToolContext {
  /** 只由项目设计会话传入；纯聊天传 null，因而不会暴露本工具。 */
  projectId: string
  /** 回合开始时是否已有设计稿；清空无文件项目的方向后，本轮必须重新上锁。 */
  initialHasFiles?: boolean
  designDocument?: string
  vfs: SessionVfs
  save: (styleBrief: string) => Project | null | Promise<Project | null>
  /** 保存成功后的事务记账，不负责持久化。 */
  onSaved?: (styleBrief: string) => void
  /** 保存失败后撤回此前已推到渲染层的本轮文件预览。 */
  onDiscard?: (changes: ReturnType<SessionVfs['changes']>) => void
}

/**
 * 把首次确认的提问结果转换为可测试的写入状态。非跳过答案仍须先落库
 * StyleBrief，避免模型把问答内容当作已经持久化的授权。
 */
export function createInitialStyleWriteGate(input: {
  styleBrief: string
  designDocument?: string
  hasFiles: boolean
  /** markers 协议没有 set_style_brief/ask_user 的解锁路径，不使用此工具专属闸门。 */
  useTools?: boolean
}): {
  isLocked: () => boolean
  onStyleQuestionAnswered: (ask: AskUserInput, answer: AskUserAnswer) => void
} {
  let locked =
    (input.useTools ?? true) &&
    !input.styleBrief.trim() &&
    !input.designDocument?.trim() &&
    !input.hasFiles
  return {
    isLocked: () => locked,
    onStyleQuestionAnswered: (ask, answer) => {
      if (ask.purpose === 'style-brief' && answer.skipped) locked = false
    }
  }
}

/** SDK 的 abort part 仍会正常结束迭代，必须显式转换成事务 outcome。 */
export function markerCompletionOutcome(modelAborted: boolean): 'complete' | 'aborted' {
  return modelAborted ? 'aborted' : 'complete'
}

export interface MarkerStyleCommitResult {
  styleSaved: boolean
  previousStyleBrief: string
  hasFileOutput: boolean
}

/** 先确认 usage 可用，再让 markers 保存视觉方向或写入文件。 */
export async function awaitMarkerUsageBeforeCommit<Usage, Commit>(
  usage: PromiseLike<Usage>,
  commit: () => Promise<Commit>
): Promise<{ usage: Usage; commit: Commit }> {
  return { usage: await usage, commit: await commit() }
}

/**
 * 版本未创建即失败时，恢复伴随文件输出的 StyleBrief，避免项目偏好领先于设计稿。
 */
export async function restoreMarkerStyleIfArtifactFailed(input: {
  commit: MarkerStyleCommitResult | null
  artifactCreated: boolean
  restore: (styleBrief: string) => Project | null | Promise<Project | null>
}): Promise<boolean> {
  if (!input.commit?.styleSaved || !input.commit.hasFileOutput || input.artifactCreated) {
    return false
  }
  const restored = await input.restore(input.commit.previousStyleBrief)
  if (!restored) throw new Error(aiText('ai.styleBrief.couldNotRestoreTheProjectSVisualDirection'))
  return true
}

/**
 * markers 协议的视觉方向提交边界。
 *
 * StyleBrief 与文件同属一条模型输出，却不在同一个存储里：前者进入项目，
 * 后者进入 VFS。这个协调器把它们收敛成「先保存方向、再灌入文件」的事务
 * 顺序，并保留没有新标记时的旧 markers 容错行为。
 */
export async function commitMarkerStyleBrief(input: {
  parser: FileStreamParser
  vfs: SessionVfs
  initialStyleBrief: string
  designDocument?: string
  initialHasFiles: boolean
  outcome: 'complete' | 'aborted' | 'error'
  save: (styleBrief: string) => Project | null | Promise<Project | null>
}): Promise<MarkerStyleCommitResult> {
  const { parser, vfs } = input
  const hasStyleMarker = parser.pendingStyleBrief !== undefined
  const hasStyleProtocol = parser.sawStyleProtocol
  const result: MarkerStyleCommitResult = {
    styleSaved: false,
    previousStyleBrief: input.initialStyleBrief,
    hasFileOutput: parser.hasChanges
  }

  // 新协议的中止/出错输出不是完整事务，连同已解析的文件一并丢弃。
  // 没有相关标记时仍走旧逻辑，保持此前 markers 回合的兼容语义。
  if (input.outcome !== 'complete') {
    if (!hasStyleProtocol) vfs.ingest(parser.files, parser.deleted)
    return result
  }

  if (hasStyleProtocol && parser.hadUnclosedFile) {
    throw new Error(
      aiText('ai.styleBrief.anUnclosedFileMarkerWasFoundVisualDirectionAndFileChangesWere')
    )
  }
  if (parser.styleProtocolAfterFile) {
    throw new Error(
      aiText('ai.styleBrief.visualDirectionOrFallbackStyleMustPrecedeFileOutputChangesWereNot')
    )
  }
  // 旧 markers 会容忍并忽略非法路径；一旦声明 StyleBrief / fallback，
  // 文件与方向就是同一事务，必须在保存方向之前验证全部路径。
  if (hasStyleProtocol) vfs.validateIngestPaths(parser.files, parser.deleted)

  const hasFileOutput = result.hasFileOutput
  const isInitialProject =
    !input.initialStyleBrief.trim() && !input.designDocument?.trim() && !input.initialHasFiles
  const hasNonemptyStyleBrief = Boolean(parser.pendingStyleBrief)
  const clearsStyleBrief = hasStyleMarker && !hasNonemptyStyleBrief

  // 首次生成不得把空清除标记当成风格确认；只有非空方向或显式 fallback 可放行。
  if (isInitialProject && hasFileOutput && !hasNonemptyStyleBrief && !parser.useStyleFallback) {
    throw new Error(aiText('ai.styleBrief.theFirstGenerationRequiresAVisual'))
  }
  if (
    clearsStyleBrief &&
    Boolean(input.initialStyleBrief.trim()) &&
    !input.initialHasFiles &&
    !input.designDocument?.trim() &&
    hasFileOutput
  ) {
    throw new Error(
      aiText('ai.styleBrief.afterClearingVisualDirectionConfirmItAgainInTheNextTurnFile')
    )
  }

  // 初始空项目里的空 marker 没有可清除的持久状态，fallback 也不应写回偏好。
  const shouldSave =
    hasStyleMarker &&
    (hasNonemptyStyleBrief || !isInitialProject) &&
    !(parser.useStyleFallback && !hasNonemptyStyleBrief && isInitialProject)

  if (shouldSave) {
    try {
      const saved = await input.save(parser.pendingStyleBrief!)
      if (!saved) throw new Error(aiText('ai.styleBrief.theProjectDoesNotExistOrCouldNotBeSaved'))
      result.styleSaved = true
    } catch {
      throw new Error(
        aiText('ai.styleBrief.couldNotSaveVisualDirectionFileChangesFromThisTurnWereDiscarded')
      )
    }
  }

  vfs.ingest(parser.files, parser.deleted)
  return result
}

/**
 * 整体视觉方向的唯一写入口。局部组件、单页例外不得调用它；成功保存前
 * VFS 不会解锁，保存失败则丢弃本回合文件改动并永久锁住写入。
 */
export function buildStyleBriefTools(
  context: StyleBriefToolContext | null,
  lang: PromptLanguage = 'zh-CN'
): ToolSet {
  if (!context) return localizedTools({}, lang)

  return localizedTools(
    {
      set_style_brief: tool({
        description: promptText(lang, 'tools.set_style_brief.description'),
        inputSchema: z.object({
          styleBrief: z
            .string()
            .describe(promptText(lang, 'tools.set_style_brief.parameters.styleBrief'))
        }),
        execute: async (input) => {
          const styleBrief = input.styleBrief.trim()
          const wasWriteBlocked = context.vfs.isWriteBlocked()
          if (wasWriteBlocked && !styleBrief) {
            return aiText(
              'ai.styleBrief.errorTheInitialVisualDirectionIsUnconfirmedUseAskUserWithPurpose'
            )
          }
          try {
            const saved = await context.save(styleBrief)
            if (!saved)
              throw new Error(aiText('ai.styleBrief.theProjectDoesNotExistOrCouldNotBeSaved'))
            context.onSaved?.(styleBrief)
          } catch {
            const changes = context.vfs.changes()
            context.vfs.blockWrites(
              aiText('ai.styleBrief.couldNotSaveTheVisualDirectionThisTurnSFileChangesWere'),
              {
                discardChanges: true,
                permanent: true
              }
            )
            context.onDiscard?.(changes)
            return aiText('ai.styleBrief.errorCouldNotSaveTheVisualDirectionThisTurnSFileChanges')
          }

          if (!styleBrief && !context.designDocument?.trim() && context.initialHasFiles === false) {
            const changes = context.vfs.changes()
            context.vfs.blockWrites(
              aiText('ai.styleBrief.visualDirectionClearedTheProjectHasNoDesignYetConfirmItAgain'),
              { discardChanges: true }
            )
            if (changes.length > 0) context.onDiscard?.(changes)
          } else {
            context.vfs.allowWrites()
          }
          return styleBrief
            ? aiText('ai.styleBrief.visualDirectionUpdatedForThisTurn', styleBrief)
            : context.designDocument?.trim()
              ? aiText('ai.styleBrief.visualStyleClearedContinueUsingTheVisualRulesInDesignMd')
              : context.initialHasFiles === false
                ? aiText(
                    'ai.styleBrief.visualDirectionClearedTheProjectHasNoDesignYetConfirmTheOverall'
                  )
                : aiText(
                    'ai.styleBrief.visualDirectionClearedForThisTurnContinueTheCurrentDesignSVisuals'
                  )
        }
      })
    },
    lang
  )
}

function fallbackOptions(lang: PromptLanguage): Record<keyof StyleFallback, readonly string[]> {
  return {
    color: [
      promptText(lang, 'style.fallback.color.graphite'),
      promptText(lang, 'style.fallback.color.indigo'),
      promptText(lang, 'style.fallback.color.forest'),
      promptText(lang, 'style.fallback.color.crimson'),
      promptText(lang, 'style.fallback.color.teal'),
      promptText(lang, 'style.fallback.color.amber')
    ],
    brightness: [
      promptText(lang, 'style.fallback.brightness.light'),
      promptText(lang, 'style.fallback.brightness.dark'),
      promptText(lang, 'style.fallback.brightness.layered')
    ],
    density: [
      promptText(lang, 'style.fallback.density.comfortable'),
      promptText(lang, 'style.fallback.density.compact'),
      promptText(lang, 'style.fallback.density.medium')
    ],
    geometry: [
      promptText(lang, 'style.fallback.geometry.sharp'),
      promptText(lang, 'style.fallback.geometry.moderate'),
      promptText(lang, 'style.fallback.geometry.rounded')
    ],
    surface: [
      promptText(lang, 'style.fallback.surface.outlined'),
      promptText(lang, 'style.fallback.surface.filled'),
      promptText(lang, 'style.fallback.surface.shadow')
    ],
    navigation: [
      promptText(lang, 'style.fallback.navigation.sidebar'),
      promptText(lang, 'style.fallback.navigation.top'),
      promptText(lang, 'style.fallback.navigation.bottom'),
      promptText(lang, 'style.fallback.navigation.none')
    ]
  }
}

/** 每个维度都带自己的 salt，避免一个项目级数字把所有视觉决定绑成一组。 */
function stableIndex(key: string, length: number): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % length
}

/**
 * 未获得用户风格方向时的确定性兜底。它不是用户偏好，不应持久化到 StyleBrief。
 */
export function styleFallback(projectId: string, lang: PromptLanguage = 'zh-CN'): StyleFallback {
  const choice = (dimension: keyof StyleFallback): string => {
    const options = fallbackOptions(lang)[dimension]
    return options[stableIndex(`${projectId}:${dimension}`, options.length)]
  }
  return {
    color: choice('color'),
    brightness: choice('brightness'),
    density: choice('density'),
    geometry: choice('geometry'),
    surface: choice('surface'),
    navigation: choice('navigation')
  }
}

function escapeMarkdownFence(value: string): string {
  return value.replace(/`{3,}/g, (fence) => '\\`'.repeat(fence.length))
}

function renderFallback(projectId: string, lang: PromptLanguage = 'zh-CN'): string {
  const fallback = styleFallback(projectId, lang)
  return promptText(lang, 'style.fallback', {
    color: fallback.color,
    brightness: fallback.brightness,
    density: fallback.density,
    geometry: fallback.geometry,
    surface: fallback.surface,
    navigation: fallback.navigation
  })
}

/**
 * 把项目已有的视觉方向转换为稳定 prompt 段。空方向时的行为取决于是否已有设计稿：
 * 第一次生成先确认，已有文件则只延续当前视觉语言。
 */
export function renderStyleBriefPrompt(
  project: Project,
  hasFiles = false,
  mode: StyleBriefPromptMode = 'tools',
  lang: PromptLanguage = 'zh-CN'
): string {
  const styleBrief = project.styleBrief?.trim() ?? ''
  const designDocument = project.designDocument?.trim() ?? ''
  if (designDocument) {
    return promptText(lang, 'style.guidance', {
      styleBrief: escapeMarkdownFence(styleBrief),
      designDocument: escapeMarkdownFence(designDocument),
      priority: project.visualStylePriority === 'designDocument' ? 'DESIGN.md' : 'Visual style'
    })
  }
  if (styleBrief) {
    return promptText(lang, 'style.direction', { styleBrief: escapeMarkdownFence(styleBrief) })
  }

  if (hasFiles) {
    return promptText(lang, 'style.continue')
  }

  if (mode === 'markers') {
    return promptText(lang, 'style.confirm.markers', { fallback: renderFallback(project.id, lang) })
  }

  return promptText(lang, 'style.confirm.tools', { fallback: renderFallback(project.id, lang) })
}
