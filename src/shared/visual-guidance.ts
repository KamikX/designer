import type { VisualGuidance } from './types'

export const MAX_DESIGN_DOCUMENT_BYTES = 64 * 1024

export function validateVisualGuidance(value: unknown): VisualGuidance {
  if (!value || typeof value !== 'object') throw new Error('视觉设置无效')
  const input = value as Record<string, unknown>
  if (
    typeof input.styleBrief !== 'string' ||
    typeof input.designDocument !== 'string' ||
    (input.visualStylePriority !== 'styleBrief' && input.visualStylePriority !== 'designDocument')
  ) {
    throw new Error('视觉设置无效')
  }
  if (new TextEncoder().encode(input.designDocument).byteLength > MAX_DESIGN_DOCUMENT_BYTES) {
    throw new Error('DESIGN.md 不能超过 64 KiB')
  }
  if (
    input.designDocument.includes('\0') ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      input.designDocument
    )
  ) {
    throw new Error('请选择有效的 UTF-8 Markdown 文件')
  }
  return {
    styleBrief: input.styleBrief.trim(),
    designDocument: input.designDocument.trim() ? input.designDocument : '',
    visualStylePriority: input.visualStylePriority
  }
}

export function decodeDesignDocument(name: string, bytes: Uint8Array): string {
  if (!/\.md$/i.test(name)) throw new Error('请选择 .md 文件')
  if (bytes.byteLength > MAX_DESIGN_DOCUMENT_BYTES) throw new Error('DESIGN.md 不能超过 64 KiB')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('请选择有效的 UTF-8 Markdown 文件')
  }
  if (!text.trim()) throw new Error('Markdown 文件不能为空')
  return validateVisualGuidance({
    styleBrief: '',
    designDocument: text,
    visualStylePriority: 'styleBrief'
  }).designDocument
}
