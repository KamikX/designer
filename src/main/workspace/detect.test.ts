import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { detectPaths } from './detect'

/**
 * 这个函数的输出会直接变成一条本地目录授权,所以两个方向都要钉住:
 * 该认的要认出来,不该认的一个都不能漏进来。
 */

const base = realpathSync(mkdtempSync(join(tmpdir(), 'detect-')))
const dir = join(base, 'my project')
const file = join(base, 'spec.md')
mkdirSync(dir, { recursive: true })
writeFileSync(file, '# spec\n')
writeFileSync(join(dir, 'a.txt'), 'a\n')

const paths = (text: string): string[] => detectPaths(text).resolved.map((d) => d.path)
const missing = (text: string): string[] => detectPaths(text).missing

describe('认得出来', () => {
  it('句子里的绝对路径', () => {
    expect(paths(`帮我看看 ${file} 这个需求`)).toEqual([file])
  })

  it('行首的路径', () => {
    expect(paths(`${base}\n照着这个项目做`)).toEqual([base])
  })

  it('带空格的路径要加引号', () => {
    expect(paths(`参考 "${dir}" 的结构`)).toEqual([dir])
  })

  it('中文标点后面的路径', () => {
    expect(paths(`目录是,${base},看一下`)).toEqual([base])
  })

  it('区分目录与文件', () => {
    const out = detectPaths(`${base} 和 ${file}`).resolved
    expect(out.find((d) => d.path === base)!.isDirectory).toBe(true)
    expect(out.find((d) => d.path === file)!.isDirectory).toBe(false)
  })

  it('~ 展开成家目录', () => {
    expect(paths('看看 ~ 里面')).toEqual([realpathSync(homedir())])
  })

  it('重复出现只算一次', () => {
    expect(paths(`${base} 还有 ${base}`)).toEqual([base])
  })

  it('一条消息最多认 3 个', () => {
    const many = [base, dir, file, homedir(), tmpdir()].join(' ')
    expect(detectPaths(many).resolved.length).toBeLessThanOrEqual(3)
  })
})

describe('写错的路径要报出来,而不是静默丢掉', () => {
  it('父目录存在、自己不存在 → 判定为写错了', () => {
    expect(missing(`看看 ${join(base, 'typo.md')}`)).toEqual([join(base, 'typo.md')])
  })

  it('父目录也不存在的不算路径——接口路径别误报', () => {
    expect(missing('支持 /api/users 这个接口')).toEqual([])
    expect(missing('看看 /this/does/not/exist/at/all')).toEqual([])
  })

  it('存在的路径不进 missing', () => {
    expect(missing(`${base} 和 ${file}`)).toEqual([])
  })
})

describe('不该认的一个都不能进来', () => {
  it('不存在的路径不进 resolved', () => {
    expect(paths('看看 /this/does/not/exist/at/all')).toEqual([])
  })

  it('URL 不算路径', () => {
    expect(paths('参考 https://example.com/design/system 这个站')).toEqual([])
  })

  it('普通词组里的斜杠', () => {
    expect(paths('做一个读/写权限的开关,支持 24/7 在线')).toEqual([])
  })

  it('相对路径不认——没有说得通的基准', () => {
    expect(paths('看看 src/main 目录')).toEqual([])
  })

  it('纯文字没有路径', () => {
    expect(paths('做一个深色风格的看板首页')).toEqual([])
  })

  it('空文本', () => {
    expect(paths('')).toEqual([])
  })
})
