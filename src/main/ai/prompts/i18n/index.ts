import english from './en-US.json'
import chinese from './zh-CN.json'
import type { Lang } from '../../../../shared/types'

export type PromptLanguage = Lang
export type PromptKey = keyof typeof english
export type PromptValues = Readonly<Record<string, unknown>>

export function resolvePromptLanguage(language: unknown): PromptLanguage {
  return language === 'zh-CN' ? 'zh-CN' : 'en-US'
}

// Only supplied placeholders are replaced, in one pass, so code and inserted user text stay literal.
export function interpolatePrompt(text: string, values: PromptValues = {}): string {
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  )
}

export function promptText(language: unknown, key: PromptKey, values: PromptValues = {}): string {
  const translations: Partial<Record<PromptKey, string>> =
    resolvePromptLanguage(language) === 'zh-CN' ? chinese : english
  return interpolatePrompt(translations[key] ?? english[key], values)
}
