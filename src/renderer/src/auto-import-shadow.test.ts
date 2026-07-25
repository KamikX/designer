import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * 防止局部变量遮蔽自动导入的名字。
 *
 * 这个坑很阴:写 `const ref = await importImage(...)` 之后,unplugin-auto-import
 * 认为本文件已经声明了 `ref`,于是**整份文件都不再注入它**,然后在几十行外
 * 一个毫不相干的 `ref('')` 上炸出 "ref is not defined"。typecheck 和 build
 * 都发现不了——它是运行时错误,而且报错位置离真正的原因很远。
 *
 * 所以用一条测试钉死:渲染层任何文件都不许用自动导入的名字当局部标识符。
 */

const AUTO_IMPORTS_DTS = 'src/renderer/types/auto-imports.d.ts'
const RENDERER_SRC = 'src/renderer/src'

/** 从生成的 dts 里取出全部自动导入的名字 */
function autoImportedNames(): Set<string> {
  const dts = readFileSync(AUTO_IMPORTS_DTS, 'utf8')
  const names = new Set<string>()
  for (const line of dts.split('\n')) {
    const hit = /^\s+const (\w+):/.exec(line)
    if (hit) names.add(hit[1])
  }
  return names
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(vue|ts)$/.test(full) && !full.endsWith('.test.ts')) out.push(full)
  }
  return out
}

/** .vue 只看 <script setup>;.ts 整份看 */
function scriptOf(file: string): string {
  const raw = readFileSync(file, 'utf8')
  if (!file.endsWith('.vue')) return raw
  return /<script setup[^>]*>([\s\S]*?)<\/script>/.exec(raw)?.[1] ?? ''
}

describe('自动导入不被局部声明遮蔽', () => {
  const names = autoImportedNames()

  it('dts 里确实有内容(否则这条测试是空转)', () => {
    expect(names.size).toBeGreaterThan(50)
    expect(names.has('ref')).toBe(true)
    expect(names.has('computed')).toBe(true)
  })

  it('渲染层没有任何文件用自动导入的名字当局部标识符', () => {
    const offenders: string[] = []

    for (const file of sourceFiles(RENDERER_SRC)) {
      const script = scriptOf(file)
      if (!script.trim()) continue
      for (const match of script.matchAll(/\b(?:const|let|var|function)\s+(\w+)\b/g)) {
        if (names.has(match[1])) offenders.push(`${file} 里的 "${match[1]}"`)
      }
    }

    expect(offenders).toEqual([])
  })
})
