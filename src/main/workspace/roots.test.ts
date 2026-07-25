import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { contains, displayPath, resolveWithin } from './roots'
import type { WorkspaceRoot } from '../../shared/types'

/**
 * 这是整个本地文件能力的安全边界,所以测试的重点不是"能不能读到",
 * 是**能不能被绕出去**。每加一种绕法就该加一条用例。
 *
 * 不测 addRoot / listRoots:那两个碰 better-sqlite3,按 Electron ABI 编译,
 * 普通 node 加载不了。纯路径判定的部分才是真正要守的。
 */

// realpath 一次:macOS 的 /var 是 /private/var 的软链,而 addRoot 存的是
// realpath 之后的路径,测试要跟生产一致
const base = realpathSync(mkdtempSync(join(tmpdir(), 'ws-roots-')))
const granted = join(base, 'granted')
const outside = join(base, 'outside')

mkdirSync(join(granted, 'src'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(granted, 'src', 'app.ts'), 'export const a = 1\n')
writeFileSync(join(granted, 'readme.md'), '# hi\n')
writeFileSync(join(outside, 'secret.env'), 'TOKEN=xxx\n')

// 授权目录里放一个指向外部的软链——最经典的绕法
let symlinkOk = true
try {
  symlinkSync(outside, join(granted, 'escape'), 'dir')
} catch {
  symlinkOk = false // Windows 上没权限建软链时跳过这条
}

const roots: WorkspaceRoot[] = [
  { id: 'r1', projectId: 'p', path: resolve(granted), name: 'granted' }
]

afterAll(() => {
  // 临时目录留给系统清理,不在测试里递归删,免得写错路径删到别处
})

describe('范围内的路径解析得到', () => {
  it('根名开头的相对写法', () => {
    expect(resolveWithin(roots, 'granted/readme.md')).toBe(resolve(granted, 'readme.md'))
  })

  it('直接相对根的写法', () => {
    expect(resolveWithin(roots, 'src/app.ts')).toBe(resolve(granted, 'src', 'app.ts'))
  })

  it('绝对路径', () => {
    expect(resolveWithin(roots, join(granted, 'readme.md'))).toBe(resolve(granted, 'readme.md'))
  })

  it('根目录本身', () => {
    expect(resolveWithin(roots, 'granted')).toBe(resolve(granted))
  })
})

describe('绕出去的一律拒绝', () => {
  it('范围外的绝对路径', () => {
    expect(() => resolveWithin(roots, join(outside, 'secret.env'))).toThrow(/不在授权范围内/)
  })

  it('用 .. 往上爬', () => {
    expect(() => resolveWithin(roots, '../outside/secret.env')).toThrow(/不在授权范围内/)
  })

  it('深层 .. 组合', () => {
    expect(() => resolveWithin(roots, 'src/../../outside/secret.env')).toThrow(/不在授权范围内/)
  })

  it.skipIf(!symlinkOk)('穿过指向外部的软链', () => {
    // 拼接结果看着还在 granted/ 里,realpath 之后才露馅——所以判定必须在
    // realpath 之后做
    expect(() => resolveWithin(roots, 'granted/escape/secret.env')).toThrow(/不在授权范围内/)
  })

  it('不存在的路径', () => {
    expect(() => resolveWithin(roots, 'granted/nope.txt')).toThrow(/不在授权范围内|不存在/)
  })

  it('空路径', () => {
    expect(() => resolveWithin(roots, '   ')).toThrow(/不能为空/)
  })

  it('一个 root 都没有时直接拒,不去碰文件系统', () => {
    expect(() => resolveWithin([], '/etc/passwd')).toThrow(/还没有授权/)
  })
})

describe('contains', () => {
  it('自身算包含', () => {
    expect(contains('/a/b', '/a/b')).toBe(true)
  })

  it('子路径算包含', () => {
    expect(contains('/a/b', '/a/b/c/d')).toBe(true)
  })

  it('兄弟目录不算——前缀相同不等于在里面', () => {
    expect(contains('/a/b', '/a/bc')).toBe(false)
  })

  it('父目录不算', () => {
    expect(contains('/a/b', '/a')).toBe(false)
  })
})

describe('displayPath', () => {
  it('缩成根名 + 相对路径,不把用户的完整磁盘路径反复喂给模型', () => {
    expect(displayPath(roots, join(granted, 'src', 'app.ts'))).toBe(
      join('granted', 'src', 'app.ts')
    )
  })

  it('根目录本身显示根名', () => {
    expect(displayPath(roots, resolve(granted))).toBe('granted')
  })

  it('范围外的原样返回', () => {
    expect(displayPath(roots, '/tmp/x')).toBe('/tmp/x')
  })
})
