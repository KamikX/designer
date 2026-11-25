import english from './en-US.json'
import chinese from './zh-CN.json'
import type { Lang } from '../types'

export type TranslationKey = keyof typeof english
const dictionaries: Record<Lang, Record<TranslationKey, string>> = {
  'en-US': english,
  'zh-CN': chinese
}
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function translate(lang: Lang, key: TranslationKey, ...values: unknown[]): string {
  const text = dictionaries[lang]?.[key] ?? english[key] ?? key
  return text.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : match
  )
}

// Only these parameters contain application messages; all other values belong to the user.
const nestedParameters: Partial<Record<TranslationKey, number[]>> = {
  'common.errorLabelText': [0],
  'messages.stillFailedAfterRetries': [1],
  'messages.http': [0],
  'messages.invalidRequestMessageFormatThisIs': [1]
}
const verbTemplates = new Set<TranslationKey>([
  'messages.lines',
  'messages.fromLine',
  'messages.changes',
  'common.files',
  'messages.changesFromThisTurn',
  'common.matches',
  'common.lines',
  'common.filesLabel',
  'common.matchesLabel'
])
const activityKeys: TranslationKey[] = [
  'common.listFiles',
  'common.viewStructure',
  'common.read',
  'common.getSourceText',
  'common.captureAnchor',
  'common.editAnchors',
  'common.search',
  'common.edit',
  'common.batchEdit',
  'common.applyPatch',
  'common.write',
  'common.move',
  'common.copy',
  'common.deleteLabel',
  'messages.viewChangesFromThisTurn',
  'common.checkStructure',
  'common.revertChanges',
  'common.updateVisualDirection',
  'messages.askYouAQuestion',
  'common.viewReferenceImage',
  'messages.recordReferenceImageNotes',
  'common.getCurrentTime',
  'common.loadSkill',
  'common.installSkill',
  'common.installMcpService',
  'common.browseDirectory',
  'common.checkPath',
  'common.findFiles',
  'common.searchLocalFiles',
  'common.readLocalFile',
  'common.parseDocument',
  'common.viewDocumentImages',
  'common.searchWeb',
  'common.openWebPage',
  'common.inspectPage',
  'common.click',
  'common.fillForm',
  'common.pressKey',
  'common.scrollPage',
  'common.preparePatch',
  'common.prepareEdit',
  'common.prepareWrite',
  'common.executePatch',
  'common.executeEdit',
  'common.executeWrite',
  'common.errorLabel'
]

// Old IPC failures and saved diagnostics contain rendered text rather than keys.
// Derive compatibility matching from locale values so Chinese never acts as an identifier.
const patterns = (Object.keys(english) as TranslationKey[]).flatMap((key) =>
  (['zh-CN', 'en-US'] as const).map((lang) => {
    const indexes: number[] = []
    const parts = dictionaries[lang][key].split(/(\{\d+\})/g).map((part) => {
      const match = /^\{(\d+)\}$/.exec(part)
      if (!match) return escapeRegex(part)
      indexes.push(Number(match[1]))
      return '(.*?)'
    })
    return { key, lang, indexes, regex: new RegExp('^' + parts.join('') + '$', 's') }
  })
)

export function translateMessage(lang: Lang, source: string, depth = 0): string {
  if (depth > 4) return source
  for (const pattern of patterns) {
    if (pattern.lang === lang) continue
    const match = pattern.regex.exec(source)
    if (!match) continue
    const values: string[] = []
    pattern.indexes.forEach((index, i) => {
      const value = match[i + 1]
      values[index] = nestedParameters[pattern.key]?.includes(index)
        ? translateMessage(lang, value, depth + 1)
        : verbTemplates.has(pattern.key) && index === 0
          ? translateActivity(lang, value, depth + 1)
          : value
    })
    return translate(lang, pattern.key, ...values)
  }
  return source
}

/** Activity prefixes are translated without interpreting user paths or search queries. */
export function translateActivity(lang: Lang, source: string, depth = 0): string {
  const translated = translateMessage(lang, source, depth)
  if (translated !== source) return translated
  const from = lang === 'en-US' ? 'zh-CN' : 'en-US'
  const keys = [...activityKeys].sort(
    (a, b) => dictionaries[from][b].length - dictionaries[from][a].length
  )
  for (const key of keys) {
    const verb = dictionaries[from][key]
    if (source.startsWith(verb)) return translate(lang, key) + source.slice(verb.length)
  }
  return source
}
