import english from './en-US.json'
import type { Lang } from '../types'

const messages: Record<string, string> = english
const han = /\p{Script=Han}/u
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// IPC messages and saved diagnostics contain interpolated Chinese source text.
// Match only known application messages; user-authored content is never passed here.
const patterns = Object.entries(messages)
  .filter(([source]) => /\{\d+\}/.test(source))
  .map(([source, target]) => {
    const indexes: number[] = []
    const parts = source.split(/(\{\d+\})/g).map((part) => {
      const match = /^\{(\d+)\}$/.exec(part)
      if (!match) return escapeRegex(part)
      indexes.push(Number(match[1]))
      return '(.*?)'
    })
    return { source, regex: new RegExp(`^${parts.join('')}$`, 's'), target, indexes }
  })

export function translate(lang: Lang, source: string, ...values: unknown[]): string {
  const text = lang === 'en-US' ? (messages[source] ?? source) : source
  return text.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : match
  )
}

export function translateMessage(lang: Lang, source: string, depth = 0): string {
  if (lang !== 'en-US' || !han.test(source) || depth > 4) return source
  if (messages[source]) return messages[source]
  for (const { source: pattern, regex, target, indexes } of patterns) {
    const match = regex.exec(source)
    if (!match) continue
    const values: string[] = []
    indexes.forEach((index, i) => {
      const nested =
        (pattern === '错误:{0}' && index === 0) ||
        (pattern === '重试 {0} 次仍失败:{1}' && index === 1) ||
        (pattern === '{0}(HTTP {1}:{2})' && index === 0) ||
        (pattern.startsWith('请求消息形态非法') && index === 1)
      const verb = pattern.startsWith('{0}') && /行|处|个文件|本轮改动/.test(pattern) && index === 0
      values[index] = nested
        ? translateMessage(lang, match[i + 1], depth + 1)
        : verb
          ? translate(lang, match[i + 1])
          : match[i + 1]
    })
    return target.replace(/\{(\d+)\}/g, (part, index: string) => values[Number(index)] ?? part)
  }
  return source
}

/** Tool labels combine an application verb with an untouched user path or query. */
export function translateActivity(lang: Lang, source: string): string {
  const translated = translateMessage(lang, source)
  if (translated !== source || lang !== 'en-US') return translated
  const verbs = [
    '列出文件',
    '查看结构',
    '读取',
    '取原文',
    '取锚点',
    '锚点编辑',
    '搜索',
    '编辑',
    '批量编辑',
    '应用补丁',
    '写入',
    '移动',
    '复制',
    '删除',
    '查看本轮改动',
    '结构自检',
    '撤销修改',
    '更新视觉方向',
    '向你提问',
    '查看参考图',
    '记录参考图要点',
    '查看当前时间',
    '加载技能',
    '安装技能',
    '安装 MCP 服务',
    '浏览目录',
    '检查路径',
    '查找文件',
    '搜索本地',
    '读取本地文件',
    '解析文档',
    '看文档图片',
    '联网搜索',
    '打开网页',
    '查看页面',
    '点击',
    '填写表单',
    '按键',
    '滚动页面',
    '准备补丁',
    '准备编辑',
    '准备写入',
    '执行补丁',
    '执行编辑',
    '执行写入',
    '错误:'
  ].sort((a, b) => b.length - a.length)
  for (const verb of verbs) {
    if (source.startsWith(verb)) return translate(lang, verb) + source.slice(verb.length)
  }
  return translated
}
