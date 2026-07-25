import { describe, expect, it } from 'vitest'
import { resolveModuleFile } from './resolve'

/**
 * 无后缀导入的路径补全。模型写 `import ... from '../useUsers'` 是训练出来的
 * 肌肉记忆(Node / 打包器的习惯),浏览器 ES 模块却要求精确路径——这组规则
 * 错了,预览就是一片 "Failed to fetch dynamically imported module"。
 */

const files = (...paths: string[]): { path: string }[] => paths.map((path) => ({ path }))

describe('resolveModuleFile', () => {
  it('精确命中优先,即使同名补全候选也存在', () => {
    const pool = files('useUsers', 'useUsers.ts')
    expect(resolveModuleFile(pool, 'useUsers')?.path).toBe('useUsers')
  })

  it('无后缀导入补全到 .ts(bug 现场:import "../useUsers" → useUsers.ts)', () => {
    const pool = files('index.html', 'composables/useUsers.ts')
    expect(resolveModuleFile(pool, 'composables/useUsers')?.path).toBe('composables/useUsers.ts')
  })

  it('后缀顺序:ts 优先于 js,脚本优先于 vue', () => {
    expect(resolveModuleFile(files('a.js', 'a.ts'), 'a')?.path).toBe('a.ts')
    expect(resolveModuleFile(files('a.vue', 'a.ts'), 'a')?.path).toBe('a.ts')
  })

  it('目录导入落到 index 文件', () => {
    const pool = files('components/index.ts', 'components/Button.vue')
    expect(resolveModuleFile(pool, 'components')?.path).toBe('components/index.ts')
  })

  it('文件名带点不算后缀:user.service → user.service.ts', () => {
    const pool = files('user.service.ts')
    expect(resolveModuleFile(pool, 'user.service')?.path).toBe('user.service.ts')
  })

  it('带已知后缀却不存在的,不做任何补全(那是真 404)', () => {
    const pool = files('useUsers.ts')
    expect(resolveModuleFile(pool, 'useUsers.js')).toBeNull()
    expect(resolveModuleFile(pool, 'missing.vue')).toBeNull()
  })

  it('什么都对不上返回 null', () => {
    expect(resolveModuleFile(files('a.ts'), 'b')).toBeNull()
  })
})
