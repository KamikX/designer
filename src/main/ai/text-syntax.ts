import { aiText } from '../i18n'
/**
 * 结构自检。
 *
 * 对应 VS Code 给 agent 配的 `read/problems`——没有它,模型改完只能靠
 * 用户看预览才知道括号少了一个,而那时候版本已经落库了。
 *
 * **只报有把握的错**:括号 / 标签配对、JSON 可解析性。宁可漏报也不误报,
 * 因为一条假错误会让模型去追一个不存在的问题,白烧好几轮工具调用——正是
 * 我们想省的那部分开销。所以:
 *
 * - 模板字符串按不透明处理,`${}` 里的括号不参与配对(可能漏报,不会误报)。
 * - HTML 里允许省略闭合标签的元素(li / p / td …)根本不进栈。
 * - 认不出的文件类型直接返回空,不猜。
 */

export interface SyntaxProblem {
  /** 1 起 */
  line: number
  /** 1 起 */
  column: number
  message: string
}

const PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
const OPENERS = new Set(Object.keys(PAIRS))
const CLOSERS = new Set(Object.values(PAIRS))

interface ScanOptions {
  lineComment?: string
  blockComment?: [string, string]
  quotes: string[]
  /** 反引号模板字符串 */
  template?: boolean
  /** JS 正则字面量 */
  regexLiteral?: boolean
}

/** 预先算好每行起点,之后由字符下标反查行列 */
function lineStartsOf(content: string): number[] {
  const starts = [0]
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function positionOf(
  starts: number[],
  index: number,
  lineOffset = 0
): { line: number; column: number } {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (starts[mid] <= index) low = mid
    else high = mid - 1
  }
  return { line: low + 1 + lineOffset, column: index - starts[low] + 1 }
}

/**
 * `/` 是正则还是除号:看前一个有意义的字符。标识符、数字、`)`、`]` 之后
 * 是除号,其余情况是正则。这是老掉牙的启发式,但在设计稿这种代码里够准。
 */
function startsRegex(content: string, slashAt: number): boolean {
  for (let i = slashAt - 1; i >= 0; i--) {
    const ch = content[i]
    if (/\s/.test(ch)) continue
    return !/[\w$)\]]/.test(ch)
  }
  return true
}

function checkDelimiters(content: string, options: ScanOptions, lineOffset = 0): SyntaxProblem[] {
  const starts = lineStartsOf(content)
  const problems: SyntaxProblem[] = []
  const stack: { ch: string; index: number }[] = []

  const { lineComment, blockComment, quotes, template, regexLiteral } = options
  let i = 0

  while (i < content.length) {
    const ch = content[i]

    if (lineComment && content.startsWith(lineComment, i)) {
      const nl = content.indexOf('\n', i)
      i = nl < 0 ? content.length : nl
      continue
    }
    if (blockComment && content.startsWith(blockComment[0], i)) {
      const close = content.indexOf(blockComment[1], i + blockComment[0].length)
      i = close < 0 ? content.length : close + blockComment[1].length
      continue
    }
    if (quotes.includes(ch)) {
      i = skipQuoted(content, i, ch)
      continue
    }
    if (template && ch === '`') {
      // 模板整段按不透明处理:${} 里的括号不参与配对,宁可漏报
      i = skipQuoted(content, i, '`')
      continue
    }
    if (regexLiteral && ch === '/' && startsRegex(content, i)) {
      i = skipRegex(content, i)
      continue
    }

    if (OPENERS.has(ch)) {
      stack.push({ ch, index: i })
    } else if (CLOSERS.has(ch)) {
      const top = stack.pop()
      if (!top) {
        problems.push({
          ...positionOf(starts, i, lineOffset),
          message: aiText('ai.textSyntax.unexpectedNoMatchingOpeningBracket', ch)
        })
      } else if (PAIRS[top.ch] !== ch) {
        const open = positionOf(starts, top.index, lineOffset)
        problems.push({
          ...positionOf(starts, i, lineOffset),
          message: aiText(
            'ai.textSyntax.foundButLineOpensWithExpected',
            ch,
            open.line,
            top.ch,
            PAIRS[top.ch]
          )
        })
      }
    }
    i++
  }

  for (const left of stack) {
    problems.push({
      ...positionOf(starts, left.index, lineOffset),
      message: aiText('ai.textSyntax.isNotClosedMissing', left.ch, PAIRS[left.ch])
    })
  }
  return problems
}

/** 从开引号处跳到闭引号之后;未闭合则到文件末尾 */
function skipQuoted(content: string, start: number, quote: string): number {
  let i = start + 1
  while (i < content.length) {
    if (content[i] === '\\') {
      i += 2
      continue
    }
    if (content[i] === quote) return i + 1
    i++
  }
  return content.length
}

/** 跳过正则字面量,字符组里的 / 不算结束 */
function skipRegex(content: string, start: number): number {
  let i = start + 1
  let inClass = false
  while (i < content.length) {
    const ch = content[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '\n') return i
    if (ch === '[') inClass = true
    else if (ch === ']') inClass = false
    else if (ch === '/' && !inClass) return i + 1
    i++
  }
  return content.length
}

/* ------------------------------------------------------------------ */
/* HTML                                                                */
/* ------------------------------------------------------------------ */

/** 自闭合元素:不需要闭合标签 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])
/** 内容按纯文本处理的元素:里面的 < > 不是标签 */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'title'])
/**
 * 规范允许省略闭合标签的元素。这些一律不进栈——HTML 本来就宽容,
 * 把 `<li>` 当成必须闭合会造出一大堆假错误。
 */
const OPTIONAL_CLOSE_TAGS = new Set([
  'li',
  'p',
  'td',
  'th',
  'tr',
  'tbody',
  'thead',
  'tfoot',
  'option',
  'optgroup',
  'dt',
  'dd',
  'colgroup',
  'rt',
  'rp'
])

interface HtmlScan {
  problems: SyntaxProblem[]
  /** 抠出来的 script 段,交给 JS 检查器 */
  scripts: { content: string; lineOffset: number }[]
}

function scanHtml(content: string): HtmlScan {
  const starts = lineStartsOf(content)
  const problems: SyntaxProblem[] = []
  const scripts: { content: string; lineOffset: number }[] = []
  const stack: { name: string; index: number }[] = []

  let i = 0
  while (i < content.length) {
    if (content.startsWith('<!--', i)) {
      const close = content.indexOf('-->', i + 4)
      i = close < 0 ? content.length : close + 3
      continue
    }
    if (content[i] !== '<') {
      i++
      continue
    }

    const tag = readTag(content, i)
    if (!tag) {
      i++
      continue
    }

    if (tag.closing) {
      const found = stack.map((s) => s.name).lastIndexOf(tag.name)
      if (found < 0) {
        if (!OPTIONAL_CLOSE_TAGS.has(tag.name) && !VOID_TAGS.has(tag.name)) {
          problems.push({
            ...positionOf(starts, i),
            message: aiText('ai.textSyntax.hasNoOpeningTag', tag.name)
          })
        }
      } else {
        for (const unclosed of stack.slice(found + 1)) {
          problems.push({
            ...positionOf(starts, unclosed.index),
            message: aiText('ai.textSyntax.isNotClosedBefore', unclosed.name, tag.name)
          })
        }
        stack.length = found
      }
      i = tag.end
      continue
    }

    if (RAW_TEXT_TAGS.has(tag.name) && !tag.selfClosing) {
      const closeAt = findRawTextEnd(content, tag.end, tag.name)
      if (tag.name === 'script') {
        const body = content.slice(tag.end, closeAt)
        // 空 script(外链)不必检查
        if (body.trim()) {
          scripts.push({ content: body, lineOffset: positionOf(starts, tag.end).line - 1 })
        }
      }
      if (closeAt >= content.length) {
        problems.push({
          ...positionOf(starts, i),
          message: aiText('ai.textSyntax.isNotClosed', tag.name)
        })
        i = content.length
      } else {
        i = content.indexOf('>', closeAt)
        i = i < 0 ? content.length : i + 1
      }
      continue
    }

    if (!tag.selfClosing && !VOID_TAGS.has(tag.name) && !OPTIONAL_CLOSE_TAGS.has(tag.name)) {
      stack.push({ name: tag.name, index: i })
    }
    i = tag.end
  }

  for (const left of stack) {
    problems.push({
      ...positionOf(starts, left.index),
      message: aiText('ai.textSyntax.isNotClosed', left.name)
    })
  }
  return { problems, scripts }
}

interface TagToken {
  name: string
  closing: boolean
  selfClosing: boolean
  /** `>` 之后的下标 */
  end: number
}

function readTag(content: string, start: number): TagToken | null {
  const match = /^<(\/?)([a-zA-Z][\w:.-]*)/.exec(content.slice(start, start + 64))
  if (!match) return null

  // 属性值里可能有 >,要跳过引号
  let i = start + match[0].length
  let quote = ''
  while (i < content.length) {
    const ch = content[i]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      break
    }
    i++
  }
  if (i >= content.length) return null

  return {
    name: match[2].toLowerCase(),
    closing: match[1] === '/',
    selfClosing: content[i - 1] === '/',
    end: i + 1
  }
}

/** 找 `</name` 的起点 */
function findRawTextEnd(content: string, from: number, name: string): number {
  const lower = content.toLowerCase()
  const at = lower.indexOf(`</${name}`, from)
  return at < 0 ? content.length : at
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

const JS_OPTIONS: ScanOptions = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  quotes: ['"', "'"],
  template: true,
  regexLiteral: true
}

const CSS_OPTIONS: ScanOptions = {
  blockComment: ['/*', '*/'],
  quotes: ['"', "'"]
}

/** 认不出的类型返回空数组——不猜,免得造假错误 */
export function checkSyntax(path: string, content: string): SyntaxProblem[] {
  const ext = path.split('.').pop()?.toLowerCase()

  switch (ext) {
    case 'json':
      return checkJson(content)
    case 'css':
    case 'scss':
    case 'less':
      return checkDelimiters(content, CSS_OPTIONS)
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'ts':
    case 'mts':
    case 'jsx':
    case 'tsx':
      return checkDelimiters(content, JS_OPTIONS)
    case 'html':
    case 'htm':
    case 'vue': {
      const scan = scanHtml(content)
      const inScripts = scan.scripts.flatMap((s) =>
        checkDelimiters(s.content, JS_OPTIONS, s.lineOffset)
      )
      return [...scan.problems, ...inScripts].sort((a, b) => a.line - b.line)
    }
    default:
      return []
  }
}

function checkJson(content: string): SyntaxProblem[] {
  try {
    JSON.parse(content)
    return []
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const at = /position (\d+)/.exec(message)
    const position = at ? positionOf(lineStartsOf(content), Number(at[1])) : { line: 1, column: 1 }
    return [{ ...position, message: aiText('ai.textSyntax.jsonParsingFailed', message) }]
  }
}
