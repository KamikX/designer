import { promptText } from './i18n'
import type { PromptLanguage } from './i18n'
/**
 * 纯聊天的系统提示词。
 *
 * ## 设计原则:默认什么都不说
 *
 * 设计模式那份提示词有近千字——身份、设计规范、文件协议、当前设计稿。那是
 * 必要的,因为它要产出可运行的多文件设计稿。
 *
 * 聊天不是。用户来这里就是想要一个干净的模型:问什么答什么,不预设它是谁、
 * 不规定输出格式、不塞设计规范。**没有任何要交代的事情时,这里返回空串,
 * chat-service 会整个不传 system**——行为和网页版聊天一致。
 *
 * 只有当用户主动打开了某个能力(授权目录、勾技能、开联网),才为那件事加一段,
 * 而且只说那件事。每一段都对应用户的一次显式操作,不存在"我没开却被塞了
 * 一堆规矩"的情况。
 */

export interface ChatPromptOptions {
  /** 已授权的本地范围说明,由 localScopePrompt 生成 */
  localScope?: string
  /** 是否开了联网搜索 */
  webSearch?: boolean
  /** 文件系统技能的目录(渐进披露的 L1),由 skills/catalog 生成 */
  skillCatalog?: string
}

export function buildChatPrompt(
  options: ChatPromptOptions = {},
  lang: PromptLanguage = 'zh-CN'
): string {
  const sections = [
    // 勾选的技能只出现在目录里(渐进披露),不再有"全文注入"这条路
    options.localScope,
    options.skillCatalog,
    options.webSearch
      ? promptText(
          lang,
          'ai.prompts.chat.webSearchTheUserEnabledWebAccessUseWebSearchForSources'
        ).trim()
      : ''
  ].filter((section): section is string => !!section?.trim())

  return sections.join('\n\n')
}
