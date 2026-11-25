import { AsyncLocalStorage } from 'node:async_hooks'
import { translate } from '../shared/i18n'
import type { TranslationKey } from '../shared/i18n'
import { promptText } from './ai/prompts/i18n'
import type { PromptKey } from './ai/prompts/i18n'
import type { Lang } from '../shared/types'

const language = new AsyncLocalStorage<Lang>()
let readLanguage: () => Lang = () => 'zh-CN'

export function bindMainLanguage(reader: () => Lang): void {
  readLanguage = reader
}

// Concurrent conversations must retain their own language across asynchronous tool calls.
export function withLanguage<T>(lang: Lang, action: () => T): T {
  return language.run(lang, action)
}

export function currentLanguage(): Lang {
  const selected = language.getStore() ?? readLanguage()
  return selected === 'zh-CN' ? 'zh-CN' : 'en-US'
}

export function text(key: TranslationKey, ...values: unknown[]): string {
  return translate(currentLanguage(), key, ...values)
}

export function aiText(key: PromptKey, ...values: unknown[]): string {
  const parameters = Object.fromEntries(values.map((value, index) => [`value${index}`, value]))
  return promptText(currentLanguage(), key, parameters)
}

/** Tool factories also run independently of a conversation in probes and tests. */
export function localizedTools(tools: import('ai').ToolSet, lang: Lang): import('ai').ToolSet {
  for (const definition of Object.values(tools)) {
    const execute = definition.execute
    if (execute) definition.execute = (...args) => withLanguage(lang, () => execute(...args))
  }
  return tools
}
