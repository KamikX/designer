/**
 * 文件结构大纲。
 *
 * 这是省 token 的第一道闸:一个 400 行的 index.html,大纲只有二三十行,
 * 模型看完就知道要改的东西在第几行,接着只读那一段。VS Code 的
 * read_file 也是这个路子——请求区间之外的部分只给大纲,不给正文。
 *
 * 刻意用启发式正则而不是真解析器:设计稿就是 html / css / js / vue 这
 * 几样,规则几十行就够用;引一套 parser 换来的精度,在"给模型指个方向"
 * 这个用途上并不值。大纲不准的后果只是模型多读一段,不会出错。
 */

export interface OutlineEntry {
  /** 1 起的行号 */
  line: number
  text: string
}

/** 大纲条目上限:再多就不叫大纲了 */
const MAX_ENTRIES = 120
/** 单条裁剪长度 */
const MAX_ENTRY_CHARS = 120

/** 块级标签:构成页面骨架的那些 */
const HTML_BLOCK =
  /^\s*<(?:!doctype|html|head|body|template|script|style|header|footer|main|nav|aside|section|article|form|fieldset|table|thead|tbody|ul|ol|dl|figure|dialog|details|canvas|svg|h[1-6])\b/i
/** 带 id 的任意标签:通常是锚点 */
const HTML_ID = /^\s*<[a-z][\w-]*\b[^>]*\sid\s*=/i

/**
 * 选择器行与 at 规则。
 *
 * `{` 不要求在行尾——`.hero { color: red; }` 这种单行规则也要进大纲。
 * 排除 `=`(挡掉 `const a = {`)和 JS 关键字开头(挡掉 `if (x) {`),
 * 否则 .vue 的脚本段会往大纲里灌噪音。
 */
const CSS_SELECTOR =
  /^\s*(?!(?:if|for|while|switch|try|catch|else|do|function|return|export|import|const|let|var|class|new)\b)[.#*:[a-zA-Z][^{}=]*\{/
const CSS_AT_RULE = /^\s*@(?:media|supports|keyframes|layer|font-face|import|container)\b/

/** 顶层声明 */
const JS_DECL =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+[\w$[{]/
/** 对象 / 类里的方法。同样要挡掉 `if (x) {` 这类控制流 */
const JS_METHOD =
  /^\s*(?:async\s+)?(?!(?:if|for|while|switch|catch|do|return)\b)[\w$]+\s*\([^)]*\)\s*\{\s*$/

const MD_HEADING = /^#{1,6}\s/
/** JSON 只取前两层的键,再深就是数据不是结构了 */
const JSON_KEY = /^\s{0,4}"[^"]+"\s*:/

type LineMatcher = (line: string) => boolean

const any =
  (...tests: RegExp[]): LineMatcher =>
  (line) =>
    tests.some((re) => re.test(line))

function matcherFor(path: string): LineMatcher | null {
  switch (path.split('.').pop()?.toLowerCase()) {
    case 'html':
    case 'htm':
      return any(HTML_BLOCK, HTML_ID)
    case 'vue':
      // 单文件组件三段都要:模板骨架、脚本声明、样式选择器
      return any(HTML_BLOCK, HTML_ID, JS_DECL, JS_METHOD, CSS_SELECTOR, CSS_AT_RULE)
    case 'css':
    case 'scss':
    case 'less':
      return any(CSS_SELECTOR, CSS_AT_RULE)
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'ts':
    case 'mts':
    case 'jsx':
    case 'tsx':
      return any(JS_DECL, JS_METHOD)
    case 'md':
      return any(MD_HEADING)
    case 'json':
      return any(JSON_KEY)
    default:
      return null
  }
}

/** 认不出的类型返回空数组——宁可没有大纲,也不要一份噪音大纲 */
export function outlineOf(path: string, lines: string[]): OutlineEntry[] {
  const match = matcherFor(path)
  if (!match) return []

  const entries: OutlineEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    if (entries.length >= MAX_ENTRIES) break
    const line = lines[i]
    if (!match(line)) continue
    entries.push({ line: i + 1, text: clip(line.trimEnd(), MAX_ENTRY_CHARS) })
  }
  return entries
}

/** 只取落在 [from, to] 行内的条目,给 read_file 补"区间之外长什么样"用 */
export function outlineBetween(entries: OutlineEntry[], from: number, to: number): OutlineEntry[] {
  return entries.filter((e) => e.line >= from && e.line <= to)
}

export function renderOutline(entries: OutlineEntry[]): string {
  if (entries.length === 0) return ''
  const width = String(entries[entries.length - 1].line).length
  return entries.map((e) => `${String(e.line).padStart(width, ' ')}→${e.text}`).join('\n')
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(本行还有 ${text.length - max} 字符)`
}
