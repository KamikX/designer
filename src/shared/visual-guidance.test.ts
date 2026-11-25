import { describe, expect, it } from 'vitest'
import {
  decodeDesignDocument,
  MAX_DESIGN_DOCUMENT_BYTES,
  validateVisualGuidance
} from './visual-guidance'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('DESIGN.md import', () => {
  it('preserves UTF-8 Markdown verbatim and accepts a BOM', () => {
    const text = '# Štýl\n\nUse **green**.\n'
    expect(decodeDesignDocument('Brand.MD', encode(text))).toBe(text)
    expect(decodeDesignDocument('DESIGN.md', encode('\uFEFF' + text))).toBe(text)
  })

  it('rejects empty, invalid UTF-8 and non-Markdown files', () => {
    expect(() => decodeDesignDocument('design.txt', encode('# Rules'))).toThrow('.md')
    expect(() => decodeDesignDocument('design.md', encode(' \n'))).toThrow()
    expect(() => decodeDesignDocument('design.md', new Uint8Array([0xc3, 0x28]))).toThrow('UTF-8')
    expect(() => decodeDesignDocument('design.md', encode('a\0b'))).toThrow('UTF-8')
  })

  it('enforces the exact byte limit, including multibyte text', () => {
    expect(
      decodeDesignDocument('design.md', encode('a'.repeat(MAX_DESIGN_DOCUMENT_BYTES)))
    ).toHaveLength(MAX_DESIGN_DOCUMENT_BYTES)
    expect(() =>
      decodeDesignDocument('design.md', encode('é'.repeat(MAX_DESIGN_DOCUMENT_BYTES / 2 + 1)))
    ).toThrow('64 KiB')
  })
})

describe('IPC visual guidance validation', () => {
  const valid = {
    styleBrief: ' Green ',
    designDocument: '# Brand\n',
    visualStylePriority: 'designDocument'
  }
  it('trims the brief, preserves the document and allows clearing it', () => {
    expect(validateVisualGuidance(valid)).toEqual({ ...valid, styleBrief: 'Green' })
    expect(validateVisualGuidance({ ...valid, designDocument: '' }).designDocument).toBe('')
  })
  it.each([
    null,
    {},
    { ...valid, styleBrief: 1 },
    { ...valid, designDocument: null },
    { ...valid, visualStylePriority: 'skills' },
    { ...valid, designDocument: '\uD800' },
    { ...valid, designDocument: 'a'.repeat(MAX_DESIGN_DOCUMENT_BYTES + 1) }
  ])('rejects invalid payloads before persistence', (value) => {
    expect(() => validateVisualGuidance(value)).toThrow()
  })
})

it('formats validation errors using an explicitly supplied language', () => {
  expect(() => validateVisualGuidance(null, 'en-US')).toThrow('Invalid visual guidance settings')
  expect(() => validateVisualGuidance(null, 'zh-CN')).toThrow('视觉设置无效')
  expect(() => decodeDesignDocument('design.md', encode(''), 'en-US')).toThrow(
    'The Markdown file must not be empty'
  )
})
