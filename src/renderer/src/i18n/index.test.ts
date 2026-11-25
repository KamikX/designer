import { afterEach, describe, expect, it } from 'vitest'
import { computed, ref } from 'vue'
import { bindLanguage, t, uiMessage, activityLabel } from './index'
import type { Lang } from '@shared/types'
import messages from '@shared/i18n/en-US.json'
import chinese from '@shared/i18n/zh-CN.json'
import type { TranslationKey } from '@shared/i18n'

afterEach(() => bindLanguage(ref<Lang>('zh-CN')))

describe('application localization', () => {
  it('updates existing computed labels when the persisted language changes', () => {
    const lang = ref<Lang>('zh-CN')
    bindLanguage(lang)
    const label = computed(() => t('common.save'))
    expect(label.value).toBe('保存')
    lang.value = 'en-US'
    expect(label.value).toBe('Save')
    lang.value = 'zh-CN'
    expect(label.value).toBe('保存')
  })

  it('preserves user values, including braces, quotes and Unicode', () => {
    bindLanguage(ref<Lang>('en-US'))
    expect(t('common.exportedTo', '/tmp/项目/{0}/"test"')).toBe('Exported to /tmp/项目/{0}/"test"')
    // Persisted data from a newer release may contain an unknown key at runtime.
    expect(t('unknown key' as TranslationKey)).toBe('unknown key')
  })

  it('translates native IPC failures and interpolated diagnostics', () => {
    bindLanguage(ref<Lang>('en-US'))
    expect(uiMessage("Error invoking remote method 'group:create': Error: 群组名称不能为空")).toBe(
      'Group name cannot be empty'
    )
    expect(uiMessage('供应商「my-provider」缺少 Base URL')).toBe(
      'Provider “my-provider” has no Base URL'
    )
  })

  it('preserves user-defined provider names that match a translated role', () => {
    bindLanguage(ref<Lang>('en-US'))
    expect(uiMessage('供应商「产品经理」缺少 Base URL')).toBe('Provider “产品经理” has no Base URL')
  })

  it('translates tool labels without changing paths or queries', () => {
    bindLanguage(ref<Lang>('en-US'))
    expect(activityLabel('读取 src/中文.vue 1-80 行')).toBe('Read src/中文.vue lines 1–80')
    expect(activityLabel('搜索 用户的查询')).toBe('Search 用户的查询')
  })

  it('keeps interpolation placeholders in every English translation', () => {
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{(\d+)\}/g)].map((match) => match[1]).sort()
    for (const [source, english] of Object.entries(messages)) {
      expect(placeholders(english), source).toEqual(placeholders(chinese[source as TranslationKey]))
    }
  })
})

describe('translation catalog compatibility', () => {
  it('uses named keys with matching EN/CN coverage', () => {
    expect(Object.keys(chinese).sort()).toEqual(Object.keys(messages).sort())
    for (const key of Object.keys(messages)) expect(key).not.toMatch(/\p{Script=Han}/u)
  })

  it('translates historical English diagnostics back to Chinese without changing user values', () => {
    bindLanguage(ref<Lang>('zh-CN'))
    expect(uiMessage('Provider “产品经理 {0}” has no Base URL')).toBe(
      '供应商「产品经理 {0}」缺少 Base URL'
    )
    expect(activityLabel('Read src/中文.vue lines 1–80')).toBe('读取 src/中文.vue 1-80 行')
  })
})
