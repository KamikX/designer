import { promptText } from './i18n'
import type { PromptLanguage } from './i18n'
import { libraryPrompt } from '../../libraries/service'
import type { ArtifactFile, Project } from '../../../shared/types'
import { fileProtocol } from './protocol'
import { craftCore } from './craft-core'
import { stackPrompt } from './stacks'

/**
 * system prompt 组装。
 *
 * 段落按**稳定性分区**(借 open-design 的缓存前缀纪律):
 *
 * - 项目稳定区(整个项目不变,可被前缀缓存命中):身份 → 模式 → 端契约 →
 *   项目背景 → 协议 → 技术栈 → 手艺底线 → 技能目录
 * - 稳定区的尾巴(内容本身稳定,但"这一轮取哪一份"逐轮变):端模板(按活动端
 *   路由)、本地授权范围(带着这句话里识别出的路径)
 * - 逐轮可变区(每轮都可能不同,放尾部,不污染前缀):当前设计稿 →
 *   预览报错 → 反 AI 味检查 → 收尾要求
 *
 * 预览报错和 lint 结果原来排在头部第 3/4 段——那既让每一轮的前缀都不一样
 * (缓存全废),又把最需要立刻行动的信息放在了离生成最远的位置。挪到尾部
 * 一举两得:前缀稳定,且 recency 偏置恰好落在"这轮必须修的问题"上。
 *
 * 端模板与本地范围同理,只是更隐蔽:它们看着像"项目属性",实际一个按用户这句话
 * 路由活动端、一个带着本轮识别出的路径,**每轮都可能变**。夹在中段时,它们一变
 * 就把后面的手艺底线和技能目录一起带下水——前缀缓存对"哪个字节变了"没有偏好,
 * 只认第一个不同的位置。所以它们排在稳定区最后一格。
 *
 * 规范排在协议之前是有意的:协议讲"怎么写文件",规范讲"写成什么样"。
 * 模型读 prompt 时越靠前的约束越容易守住,而设计质量正是这个产品的命根子。
 *
 * 两种协议模式:
 * - markers:老路子,注入 <antdFile> 协议 + 当前版本全部文件全文。
 * - tools:模型有工具调用能力时走这条,只注入文件树,正文由模型按需
 *   read_file。输入 token 同样降一个数量级——这是 VFS 的另一半收益。
 *
 * 两套协议不能同时出现:一起给模型会混用(一边调 edit_file 一边吐
 * <antdFile>),所以 tools 模式下 FILE_PROTOCOL 整段不注入。
 */
export type PromptMode = 'markers' | 'tools'

export function buildSystemPrompt(
  project: Project,
  currentFiles: ArtifactFile[],
  options: {
    mode?: PromptMode
    baseVersion?: number
    localScope?: string
    /** 上一版预览的运行时错误。跑不起来比任何设计意见都优先——放尾部可变区吃 recency */
    previewError?: string
    /** 上一版产物的反 AI 味检查结果。和 previewError 一样放尾部可变区 */
    slopLint?: string
    /** 文件系统技能的目录(渐进披露的 L1),由 skills/catalog 生成 */
    skillCatalog?: string
    /** 项目视觉方向：首次确认 / 已有风格 / 延续现有文件三种分支，由 style-brief 生成 */
    styleBriefPrompt?: string
    /** 端契约:勾选端的角色定位 + 提问纪律 + 多端交付结构,由 prompts/targets 生成 */
    targetContract?: string
    /** 勾选端的设计模板正文,组装期直接注入(不走 activate_skill) */
    targetTemplates?: string
    /** 本轮是否有 capture_preview(多模态模型 + tools 模式才有) */
    captureHint?: boolean
  } = {},
  lang: PromptLanguage = 'zh-CN'
): string {
  const mode = options.mode ?? 'markers'
  const modeText =
    project.designMode === 'design'
      ? promptText(lang, 'system.mode.design')
      : promptText(lang, 'system.mode.prototype')

  const sections = [
    // ---- 项目稳定区 ----
    promptText(lang, 'system.identity'),
    modeText,
    options.styleBriefPrompt ?? '',
    options.targetContract ?? '',
    project.description
      ? promptText(lang, 'system.projectBackground', { projectDescription: project.description })
      : '',
    mode === 'tools' ? toolProtocol(lang) : fileProtocol(lang),
    mode === 'tools' && options.captureHint ? captureProtocol(lang) : '',
    stackPrompt(project.stack, project.libs ?? [], lang),
    libraryPrompt(project.externalLibraries ?? [], project.stack, project.libs ?? [], lang),
    craftCore(lang),
    options.skillCatalog ?? '',
    // ---- 稳定区的尾巴:内容稳定但**这一轮取哪份**会变,排最后才不牵连前面 ----
    options.targetTemplates ?? '',
    options.localScope ?? '',
    // ---- 逐轮可变区 ----
    options.baseVersion !== undefined
      ? promptText(lang, 'files.baseVersion', { version: options.baseVersion })
      : '',
    mode === 'tools' ? renderFileTree(currentFiles, lang) : renderCurrentFiles(currentFiles, lang),
    options.previewError ?? '',
    options.slopLint ?? '',
    closingText(lang)
  ]
  return sections.filter(Boolean).join('\n\n')
}

function closingText(lang: PromptLanguage): string {
  return [
    promptText(lang, 'system.closing').trim(),
    promptText(lang, 'system.responseLanguage')
  ].join('\n')
}

function captureProtocol(lang: PromptLanguage): string {
  return promptText(lang, 'protocol.capture').trim()
}

function toolProtocol(lang: PromptLanguage): string {
  return promptText(lang, 'protocol.tools').trim()
}

/**
 * tools 模式:只给树,正文让模型自己按需读。
 *
 * 顺手把行数一起给出来——模型看一眼就知道哪些文件大到不该整份读,
 * 省掉一次"读了才发现太大"的往返。
 */
function renderFileTree(files: ArtifactFile[], lang: PromptLanguage = 'zh-CN'): string {
  if (files.length === 0) {
    return promptText(lang, 'files.empty.tools')
  }
  const tree = files
    .map((f) => {
      const lines = f.content ? f.content.replace(/\n$/, '').split('\n').length : 0
      return promptText(lang, 'files.tree.entry', { path: f.path, lines: lines })
    })
    .join('\n')
  return promptText(lang, 'files.tree.tools', { tree: tree })
}

/** markers 模式:全文注入,只在这里注入一次(单点) */
function renderCurrentFiles(files: ArtifactFile[], lang: PromptLanguage = 'zh-CN'): string {
  if (files.length === 0) {
    return promptText(lang, 'files.empty.markers')
  }
  const tree = files.map((f) => `- ${f.path}`).join('\n')
  const bodies = files
    .map((f) => `<antdFile path="${f.path}">\n${f.content.trimEnd()}\n</antdFile>`)
    .join('\n\n')
  return promptText(lang, 'files.contents.markers', { tree: tree, bodies: bodies })
}
