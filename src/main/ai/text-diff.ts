import { aiText } from '../i18n'
/**
 * 行级 unified diff。
 *
 * 给 diff_changes 工具用:模型收尾前想确认"这一轮到底改了什么",看 diff
 * 比重读一遍文件便宜一个数量级——这正是 VS Code 给 agent 配
 * `search/changes` 的理由。
 *
 * 用 LCS 动态规划而不是 Myers:设计稿文件几百行,O(n·m) 完全够快,代码
 * 少一半。超过 MAX_DIFF_LINES 的直接给摘要,不硬算。
 */

/** 单侧行数上限:再大就不出 diff 了,DP 表会吃太多内存 */
const MAX_DIFF_LINES = 1500
/** 每个 hunk 前后保留的上下文行数 */
const CONTEXT = 3

type Op = ' ' | '-' | '+'

interface DiffLine {
  op: Op
  text: string
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  // 末尾换行会切出一个空串,不该算作一行
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 最长公共子序列回溯出的编辑脚本 */
function diffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length
  const m = after.length
  // dp[i][j] = before[i..] 与 after[j..] 的 LCS 长度,用一维数组存二维表
  const dp = new Int32Array((n + 1) * (m + 1))
  const at = (i: number, j: number): number => i * (m + 1) + j

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] =
        before[i] === after[j]
          ? dp[at(i + 1, j + 1)] + 1
          : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ op: ' ', text: before[i] })
      i++
      j++
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      out.push({ op: '-', text: before[i] })
      i++
    } else {
      out.push({ op: '+', text: after[j] })
      j++
    }
  }
  while (i < n) out.push({ op: '-', text: before[i++] })
  while (j < m) out.push({ op: '+', text: after[j++] })
  return out
}

/**
 * 输出 `--- / +++ / @@` 形式的 unified diff。无差异时返回空串。
 */
export function unifiedDiff(path: string, beforeText: string, afterText: string): string {
  if (beforeText === afterText) return ''

  const before = splitLines(beforeText)
  const after = splitLines(afterText)

  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) {
    return aiText(
      'ai.textDiff.fileTooLargeForALineByLineDiffLinesLines',
      path,
      path,
      before.length,
      after.length
    )
  }

  const script = diffLines(before, after)
  const hunks = groupHunks(script)
  if (hunks.length === 0) return ''

  return [`--- ${path}`, `+++ ${path}`, ...hunks].join('\n')
}

/** 把编辑脚本切成带上下文的 hunk,连续的纯上下文段落折叠掉 */
function groupHunks(script: DiffLine[]): string[] {
  const changedAt = script.map((l) => l.op !== ' ')
  const hunks: string[] = []

  let index = 0
  while (index < script.length) {
    if (!changedAt[index]) {
      index++
      continue
    }
    // 向前后各扩 CONTEXT 行;相邻改动块若上下文重叠会自然并进同一个 hunk
    let start = Math.max(0, index - CONTEXT)
    let end = index
    while (end < script.length) {
      const nextChange = changedAt.indexOf(true, end + 1)
      if (nextChange >= 0 && nextChange - end <= CONTEXT * 2) {
        end = nextChange
      } else {
        break
      }
    }
    end = Math.min(script.length - 1, end + CONTEXT)

    // 行号要按 hunk 起点之前的增删数量推算
    let beforeLine = 1
    let afterLine = 1
    for (let k = 0; k < start; k++) {
      if (script[k].op !== '+') beforeLine++
      if (script[k].op !== '-') afterLine++
    }

    const body = script.slice(start, end + 1)
    const beforeCount = body.filter((l) => l.op !== '+').length
    const afterCount = body.filter((l) => l.op !== '-').length
    hunks.push(
      `@@ -${beforeLine},${beforeCount} +${afterLine},${afterCount} @@\n` +
        body.map((l) => `${l.op}${l.text}`).join('\n')
    )

    index = end + 1
    start = 0
  }
  return hunks
}
