import { translate } from './i18n'
import type { Lang, VisualGuidance } from './types'

export const MAX_DESIGN_DOCUMENT_BYTES = 64 * 1024

export function validateVisualGuidance(value: unknown, lang: Lang = 'zh-CN'): VisualGuidance {
  if (!value || typeof value !== 'object')
    throw new Error(translate(lang, 'messages.invalidVisualGuidanceSettings'))
  const input = value as Record<string, unknown>
  if (
    typeof input.styleBrief !== 'string' ||
    typeof input.designDocument !== 'string' ||
    (input.visualStylePriority !== 'styleBrief' && input.visualStylePriority !== 'designDocument')
  ) {
    throw new Error(translate(lang, 'messages.invalidVisualGuidanceSettings'))
  }
  if (new TextEncoder().encode(input.designDocument).byteLength > MAX_DESIGN_DOCUMENT_BYTES) {
    throw new Error(translate(lang, 'messages.designMdMustNotExceed64Kib'))
  }
  if (
    input.designDocument.includes('\0') ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      input.designDocument
    )
  ) {
    throw new Error(translate(lang, 'messages.chooseAValidUtf8MarkdownFile'))
  }
  return {
    styleBrief: input.styleBrief.trim(),
    designDocument: input.designDocument.trim() ? input.designDocument : '',
    visualStylePriority: input.visualStylePriority
  }
}

export function decodeDesignDocument(
  name: string,
  bytes: Uint8Array,
  lang: Lang = 'zh-CN'
): string {
  if (!/\.md$/i.test(name)) throw new Error(translate(lang, 'messages.chooseAMdFile'))
  if (bytes.byteLength > MAX_DESIGN_DOCUMENT_BYTES)
    throw new Error(translate(lang, 'messages.designMdMustNotExceed64Kib'))
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(translate(lang, 'messages.chooseAValidUtf8MarkdownFile'))
  }
  if (!text.trim()) throw new Error(translate(lang, 'messages.theMarkdownFileMustNotBeEmpty'))
  return validateVisualGuidance(
    {
      styleBrief: '',
      designDocument: text,
      visualStylePriority: 'styleBrief'
    },
    lang
  ).designDocument
}
