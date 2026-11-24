import { describe, expect, it } from 'vitest'
import english from './en-US.json'
import chinese from './zh-CN.json'
import { interpolatePrompt, promptText, resolvePromptLanguage } from './index'
import type { PromptKey } from './index'

const placeholders = (text: string): string[] =>
  [...new Set([...text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]))].sort()

describe('designer prompt translations', () => {
  it('keeps Chinese keys and placeholders aligned with the English source', () => {
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort())
    for (const key of Object.keys(english) as PromptKey[]) {
      expect(placeholders(chinese[key]), key).toEqual(placeholders(english[key]))
      expect(english[key], key).not.toMatch(/\p{Script=Han}/u)
      expect(english[key].trim(), key).not.toBe('')
      expect(chinese[key].trim(), key).not.toBe('')
    }
  })

  it('uses English for missing or unsupported language settings', () => {
    for (const language of [undefined, null, 'sk-SK', 'invalid']) {
      expect(resolvePromptLanguage(language)).toBe('en-US')
      expect(promptText(language, 'system.identity')).toBe(english['system.identity'])
    }
    expect(promptText('zh-CN', 'system.identity')).toBe(chinese['system.identity'])
  })

  it('falls back to the English value for a missing Chinese translation', () => {
    const translations: Partial<Record<PromptKey, string>> = chinese
    const saved = translations['system.identity']
    try {
      delete translations['system.identity']
      expect(promptText('zh-CN', 'system.identity')).toBe(english['system.identity'])
    } finally {
      translations['system.identity'] = saved
    }
  })

  it('preserves literal code and never recursively interpolates inserted content', () => {
    const userText = '```css\n:root { color: red; }\n``` {other} $& ${KEY}'
    expect(interpolatePrompt('{text}\n@theme { ... }\n{other}', { text: userText })).toBe(
      `${userText}\n@theme { ... }\n{other}`
    )
    expect(interpolatePrompt('{value} {zero} {flag}', { value: '$&', zero: 0, flag: false })).toBe(
      '$& 0 false'
    )
  })
})
