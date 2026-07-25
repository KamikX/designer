import type { ArtifactFile, Project } from '../../../shared/types'
import { FILE_PROTOCOL } from './protocol'
import { stackPrompt } from './stacks'

/**
 * system prompt 组装:身份段 + 模式段 + 文件协议段 + 技术栈段 + 当前设计稿。
 *
 * 当前设计稿全文只在这里注入一次(单点)。历史消息里的文件体永不回放,
 * 多轮修改时模型看到的永远是"最新树 + 精简对话史"。
 */
export function buildSystemPrompt(project: Project, currentFiles: ArtifactFile[]): string {
  const modeText =
    project.designMode === 'design'
      ? '追求高质量、可直接交付的视觉与交互:统一的间距与层级、精心的配色与字体、合理的空态与 hover 反馈。'
      : '追求快速验证想法的原型:结构与流程优先,视觉从简。'

  const sections = [
    '你是一名资深产品 UI 设计师兼前端工程师,在桌面设计工具中与用户协作产出设计稿。',
    modeText,
    project.description ? `项目背景:${project.description}` : '',
    FILE_PROTOCOL,
    stackPrompt(project.stack),
    renderCurrentFiles(currentFiles),
    '解说用中文,简短聚焦;文件内容完整可运行。'
  ]
  return sections.filter(Boolean).join('\n\n')
}

function renderCurrentFiles(files: ArtifactFile[]): string {
  if (files.length === 0) {
    return '## 当前设计稿\n\n还没有任何文件,这是第一版,请从入口文件开始创建。'
  }
  const tree = files.map((f) => `- ${f.path}`).join('\n')
  const bodies = files
    .map((f) => `<antdFile path="${f.path}">\n${f.content.trimEnd()}\n</antdFile>`)
    .join('\n\n')
  return `## 当前设计稿(最新版全文)\n\n文件树:\n${tree}\n\n${bodies}\n\n修改时只输出变化的文件。`
}
