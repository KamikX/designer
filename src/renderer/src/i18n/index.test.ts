import { afterEach, describe, expect, it } from 'vitest'
import { computed, ref } from 'vue'
import { bindLanguage, t, uiMessage, activityLabel } from './index'
import type { Lang } from '@shared/types'
import messages from '@shared/i18n/en-US.json'

afterEach(() => bindLanguage(ref<Lang>('zh-CN')))

describe('application localization', () => {
  it('updates existing computed labels when the persisted language changes', () => {
    const lang = ref<Lang>('zh-CN')
    bindLanguage(lang)
    const label = computed(() => t('保存'))
    expect(label.value).toBe('保存')
    lang.value = 'en-US'
    expect(label.value).toBe('Save')
    lang.value = 'zh-CN'
    expect(label.value).toBe('保存')
  })

  it('preserves user values, including braces, quotes and Unicode', () => {
    bindLanguage(ref<Lang>('en-US'))
    expect(t('已导出到 {0}', '/tmp/项目/{0}/"test"')).toBe('Exported to /tmp/项目/{0}/"test"')
    expect(t('unknown key')).toBe('unknown key')
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
      expect(placeholders(english), source).toEqual(placeholders(source))
    }
  })
})
