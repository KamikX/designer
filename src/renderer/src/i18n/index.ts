import type { Ref } from 'vue'
import { translate, translateMessage, translateActivity } from '@shared/i18n'
import type { Lang } from '@shared/types'

// Config binds the persisted language; translations can also run in isolated tests.
let readLanguage: () => Lang = () => 'zh-CN'

export function bindLanguage(value: Readonly<Ref<Lang>>): void {
  readLanguage = () => value.value
}

export function t(source: string, ...values: unknown[]): string {
  return translate(readLanguage(), source, ...values)
}

export function uiMessage(source: string | null | undefined): string {
  if (!source) return ''
  const text = source.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
  return translateMessage(readLanguage(), text)
}

export function activityLabel(source: string): string {
  return translateActivity(readLanguage(), source)
}
