export interface GroupMentionMember {
  id: string
  name: string
}

export type MentionToken =
  { type: 'text'; text: string } | { type: 'member'; memberId: string; name: string }

interface TextRange {
  start: number
  end: number
}

interface MentionOccurrence {
  start: number
  end: number
  member: GroupMentionMember
}

type MarkdownContainerToken = { type: 'blockquote' } | { type: 'list'; continuationColumns: number }

interface MarkdownContainer {
  content: string
  contentOffset: number
  tokens: MarkdownContainerToken[]
}

interface FenceOpening {
  marker: string
  markerOffset: number
}

interface BacktickRun {
  start: number
  end: number
  segment: number
  closingStart: number | null
}

const LEGACY_MEMBER_IDS = new Set(['pm', 'ui', 'be', 'fe', 'qa'])
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/
const WORD_CHARACTER_PATTERN = /[\p{L}\p{N}_]/u

function isMemberId(id: string): boolean {
  return ULID_PATTERN.test(id) || LEGACY_MEMBER_IDS.has(id)
}

function isConfiguredMemberId(id: string): boolean {
  return ULID_PATTERN.test(id)
}

function isBackslashEscaped(text: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) backslashes++
  return backslashes % 2 === 1
}

function escapeCanonicalLabel(name: string): string {
  return name.replace(/([\\`])/g, '\\$1')
}

function decodeCanonicalLabel(label: string): string {
  return label.replace(/\\([\\`])/g, '$1')
}

function markdownColumnAfter(text: string, initialColumn: number): number {
  let column = initialColumn
  for (const character of text) {
    column = character === '\t' ? column + (4 - (column % 4)) : column + 1
  }
  return column
}

function indexBacktickRuns(text: string): Map<number, BacktickRun> {
  const runs: BacktickRun[] = []
  const fenceDelimiterStarts = findFenceDelimiterStarts(text)
  const segmentStarts = findInlineSegmentStarts(text)
  let index = 0
  let segment = 0
  let nextSegmentIndex = 1

  while (index < text.length) {
    while (nextSegmentIndex < segmentStarts.length && index >= segmentStarts[nextSegmentIndex]) {
      segment++
      nextSegmentIndex++
    }

    if (fenceDelimiterStarts.has(index)) {
      while (text[index] === '`') index++
      continue
    }

    if (text[index] !== '`' || isBackslashEscaped(text, index)) {
      index++
      continue
    }

    const start = index
    index++
    while (text[index] === '`') index++
    runs.push({ start, end: index, segment, closingStart: null })
  }

  const nextBySegment = new Map<number, Map<number, number>>()
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]
    const length = run.end - run.start
    const nextByLength = nextBySegment.get(run.segment) ?? new Map<number, number>()
    run.closingStart = nextByLength.get(length) ?? null
    nextByLength.set(length, run.start)
    nextBySegment.set(run.segment, nextByLength)
  }

  return new Map(runs.map((run) => [run.start, run]))
}

function parseMarkdownContainer(line: string): MarkdownContainer {
  const tokens: MarkdownContainerToken[] = []
  let offset = 0
  let column = 0

  while (true) {
    const content = line.slice(offset)
    const blockquote = content.match(/^ {0,3}>[ \t]?/)
    if (blockquote) {
      tokens.push({ type: 'blockquote' })
      offset += blockquote[0].length
      column = markdownColumnAfter(blockquote[0], column)
      continue
    }

    const list = content.match(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/)
    if (list) {
      const nextColumn = markdownColumnAfter(list[0], column)
      tokens.push({ type: 'list', continuationColumns: nextColumn - column })
      offset += list[0].length
      column = nextColumn
      continue
    }

    return { content, contentOffset: offset, tokens }
  }
}

function parseFenceOpening(container: MarkdownContainer): FenceOpening | null {
  const opening = container.content.match(/^( {0,3})(`{3,}|~{3,})(.*)$/)
  if (!opening) return null
  if (opening[2][0] === '`' && opening[3].includes('`')) return null
  return {
    marker: opening[2],
    markerOffset: container.contentOffset + opening[1].length
  }
}

type InlineBlockKind =
  'blank' | 'fence' | 'heading' | 'list' | 'blockquote' | 'setext' | 'thematic' | 'plain'

function inlineBlockKind(line: string): InlineBlockKind {
  if (/^[ \t]*$/.test(line)) return 'blank'
  const container = parseMarkdownContainer(line)
  if (parseFenceOpening(container)) return 'fence'
  if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(container.content)) return 'heading'
  if (container.tokens.some((token) => token.type === 'list')) return 'list'
  if (container.tokens.some((token) => token.type === 'blockquote')) return 'blockquote'
  if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(container.content)) return 'setext'
  if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(container.content)) {
    return 'thematic'
  }
  return 'plain'
}

function findInlineSegmentStarts(text: string): number[] {
  const starts = [0]
  let lineStart = 0
  let previousKind: InlineBlockKind | null = null
  let forceNewSegment = false

  while (lineStart < text.length) {
    const lineEnd = text.indexOf('\n', lineStart)
    const contentEnd = lineEnd === -1 ? text.length : lineEnd
    const line = text.slice(lineStart, contentEnd).replace(/\r$/, '')
    const kind = inlineBlockKind(line)
    const startsBlock =
      kind === 'fence' ||
      kind === 'heading' ||
      kind === 'list' ||
      kind === 'setext' ||
      kind === 'thematic' ||
      (kind === 'blockquote' && previousKind !== 'blockquote')

    if (lineStart > 0 && (forceNewSegment || startsBlock)) starts.push(lineStart)

    forceNewSegment =
      kind === 'blank' ||
      kind === 'fence' ||
      kind === 'heading' ||
      kind === 'setext' ||
      kind === 'thematic'
    previousKind = kind
    if (lineEnd === -1) break
    lineStart = lineEnd + 1
  }

  return starts
}

function findFenceDelimiterStarts(text: string): Set<number> {
  const starts = new Set<number>()
  let lineStart = 0

  while (lineStart < text.length) {
    const lineEnd = text.indexOf('\n', lineStart)
    const contentEnd = lineEnd === -1 ? text.length : lineEnd
    const line = text.slice(lineStart, contentEnd).replace(/\r$/, '')
    const opening = parseFenceOpening(parseMarkdownContainer(line))
    if (opening?.marker[0] === '`') starts.add(lineStart + opening.markerOffset)
    if (lineEnd === -1) break
    lineStart = lineEnd + 1
  }

  return starts
}

function contentInMarkdownContainer(
  line: string,
  tokens: readonly MarkdownContainerToken[]
): string | null {
  let offset = 0
  let column = 0
  let requiredColumn = 0

  for (const token of tokens) {
    const content = line.slice(offset)
    if (token.type === 'blockquote') {
      const blockquote = content.match(/^ {0,3}>[ \t]?/)
      if (!blockquote) return null
      offset += blockquote[0].length
      column = markdownColumnAfter(blockquote[0], column)
      requiredColumn = column
      continue
    }

    if (/^[ \t]*$/.test(content)) return ''
    requiredColumn += token.continuationColumns
    while (column < requiredColumn) {
      const character = line[offset]
      if (character !== ' ' && character !== '\t') return null
      column = markdownColumnAfter(character, column)
      offset++
    }
  }

  return line.slice(offset)
}

/**
 * 围栏和行内代码会原样进入文本 token；这里只返回允许解释提及的区间。
 * 先扫描完整文本，保证围栏起点即使在路由所看的末五行之前也不会丢失。
 */
function proseRanges(text: string): TextRange[] {
  const ranges: TextRange[] = []
  const backtickRuns = indexBacktickRuns(text)
  let proseStart = 0
  let index = 0

  const pushProse = (end: number): void => {
    if (end > proseStart) ranges.push({ start: proseStart, end })
  }

  while (index < text.length) {
    const atLineStart = index === 0 || text[index - 1] === '\n'
    if (atLineStart) {
      const lineEnd = text.indexOf('\n', index)
      const contentEnd = lineEnd === -1 ? text.length : lineEnd
      const line = text.slice(index, contentEnd).replace(/\r$/, '')
      const container = parseMarkdownContainer(line)
      const opening = parseFenceOpening(container)

      if (opening) {
        pushProse(index)
        const marker = opening.marker[0]
        const minimumLength = opening.marker.length
        let cursor = lineEnd === -1 ? text.length : lineEnd + 1
        let codeEnd = text.length

        while (cursor < text.length) {
          const closingLineEnd = text.indexOf('\n', cursor)
          const closingContentEnd = closingLineEnd === -1 ? text.length : closingLineEnd
          const closingLine = text.slice(cursor, closingContentEnd).replace(/\r$/, '')
          const closingContent = contentInMarkdownContainer(closingLine, container.tokens)
          if (closingContent == null) {
            codeEnd = cursor
            break
          }
          const closing = closingContent?.match(/^ {0,3}(`+|~+)[ \t]*$/)

          if (closing && closing[1][0] === marker && closing[1].length >= minimumLength) {
            codeEnd = closingLineEnd === -1 ? text.length : closingLineEnd + 1
            break
          }
          cursor = closingLineEnd === -1 ? text.length : closingLineEnd + 1
        }

        index = codeEnd
        proseStart = codeEnd
        continue
      }
    }

    const openingRun = backtickRuns.get(index)
    if (openingRun?.closingStart != null) {
      const closingRun = backtickRuns.get(openingRun.closingStart)
      if (closingRun) {
        pushProse(index)
        index = closingRun.end
        proseStart = index
        continue
      }
    }

    index++
  }

  pushProse(text.length)
  return ranges
}

function hasStartBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text[index - 1]
  return previous !== '\\' && !WORD_CHARACTER_PATTERN.test(previous)
}

function hasEndBoundary(text: string, index: number): boolean {
  return index >= text.length || !WORD_CHARACTER_PATTERN.test(text[index])
}

function validMembers(members: readonly GroupMentionMember[]): GroupMentionMember[] {
  return members.filter(
    (member) => isMemberId(member.id) && member.name.length > 0 && !member.name.includes('\n')
  )
}

function findMentions(
  text: string,
  members: readonly GroupMentionMember[],
  startAt = 0
): MentionOccurrence[] {
  const currentMembers = validMembers(members)
  const membersById = new Map(currentMembers.map((member) => [member.id, member]))
  const membersByLongestName = [...currentMembers].sort((a, b) => b.name.length - a.name.length)
  const mentions: MentionOccurrence[] = []

  for (const range of proseRanges(text)) {
    let index = Math.max(range.start, startAt)

    while (index < range.end) {
      if (text[index] !== '@' || !hasStartBoundary(text, index)) {
        index++
        continue
      }

      const canonical = text
        .slice(index, range.end)
        .match(/^@\[([^\]\r\n]+)\]\(member:([0-9A-Z]+)\)/)
      if (canonical) {
        const member = membersById.get(canonical[2])
        const name = decodeCanonicalLabel(canonical[1])
        if (member && isConfiguredMemberId(canonical[2]) && member.name === name) {
          mentions.push({ start: index, end: index + canonical[0].length, member })
          index += canonical[0].length
          continue
        }
      }

      const member = membersByLongestName.find((candidate) => {
        const end = index + candidate.name.length + 1
        return text.startsWith(`@${candidate.name}`, index) && hasEndBoundary(text, end)
      })

      if (member) {
        const end = index + member.name.length + 1
        mentions.push({ start: index, end, member })
        index = end
        continue
      }

      index++
    }
  }

  return mentions
}

function appendText(tokens: MentionToken[], text: string): void {
  if (!text) return
  const previous = tokens[tokens.length - 1]
  if (previous?.type === 'text') previous.text += text
  else tokens.push({ type: 'text', text })
}

function lastLinesStart(text: string, lineCount: number): number {
  const meaningfulEnd = text.trimEnd().length
  let remainingBreaks = lineCount

  for (let index = meaningfulEnd - 1; index >= 0; index--) {
    if (text[index] !== '\n') continue
    remainingBreaks--
    if (remainingBreaks === 0) return index + 1
  }

  return 0
}

function hasUserMention(text: string, startAt: number): boolean {
  for (const range of proseRanges(text)) {
    let index = Math.max(range.start, startAt)
    while (index < range.end) {
      const end = index + '@用户'.length
      if (
        text.startsWith('@用户', index) &&
        hasStartBoundary(text, index) &&
        end <= range.end &&
        hasEndBoundary(text, end)
      ) {
        return true
      }
      index++
    }
  }
  return false
}

export function createGroupMention(member: GroupMentionMember): string {
  if (isConfiguredMemberId(member.id)) {
    return `@[${escapeCanonicalLabel(member.name)}](member:${member.id})`
  }
  if (LEGACY_MEMBER_IDS.has(member.id)) return `@${member.name}`
  throw new Error('群组成员 ID 必须是 ULID 或内置角色 ID')
}

export function tokenizeGroupMentions(
  text: string,
  members: readonly GroupMentionMember[]
): MentionToken[] {
  const mentions = findMentions(text, members)
  const tokens: MentionToken[] = []
  let cursor = 0

  for (const mention of mentions) {
    appendText(tokens, text.slice(cursor, mention.start))
    tokens.push({
      type: 'member',
      memberId: mention.member.id,
      name: mention.member.name
    })
    cursor = mention.end
  }
  appendText(tokens, text.slice(cursor))

  return tokens
}

export function mentionsToModelText(text: string, members: readonly GroupMentionMember[]): string {
  return tokenizeGroupMentions(text, members)
    .map((token) => (token.type === 'member' ? `@${token.name}` : token.text))
    .join('')
}

export function mentionsToMarkdown(text: string, members: readonly GroupMentionMember[]): string {
  return tokenizeGroupMentions(text, members)
    .map((token) => {
      if (token.type === 'text') return token.text
      const safeName = token.name.replace(/([\\[\]<>`])/g, '\\$1')
      return `[@${safeName}](group-member:${token.memberId})`
    })
    .join('')
}

/** 用户消息只由第一个有效、非代码区的成员提及启动接力。 */
export function firstMention(text: string, members: readonly GroupMentionMember[]): string | null {
  return findMentions(text, members)[0]?.member.id ?? null
}

/**
 * Agent 只在末尾五行移交；@用户 的正常收链优先于成员接棒。
 * 自我提及不立即结束，以便继续寻找同一片段里的下一位成员。
 */
export function nextMention(
  text: string,
  members: readonly GroupMentionMember[],
  selfId: string
): string | null {
  const startAt = lastLinesStart(text, 5)
  if (hasUserMention(text, startAt)) return null
  return (
    findMentions(text, members, startAt).find((mention) => mention.member.id !== selfId)?.member
      .id ?? null
  )
}
