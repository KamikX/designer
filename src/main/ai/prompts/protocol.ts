import { promptText } from './i18n'
import type { PromptLanguage } from './i18n'
/**
 * 文件输出协议说明,所有技术栈模板共用。
 * few-shot 是护栏的第一层:弱一些的模型(尤其 openai-compatible 长尾)
 * 靠示例比靠描述可靠得多。
 */
export function fileProtocol(lang: PromptLanguage): string {
  return promptText(lang, 'protocol.markers').trim()
}
export const FILE_PROTOCOL = fileProtocol('zh-CN')
