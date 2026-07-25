import { describe, expect, it } from 'vitest'
import { exportDirName, sanitizeName } from './export-name'

/**
 * 这份规则被两个进程共用:主进程按它建导出目录,渲染层的文件树按它显示
 * 根节点。钉住行为,免得哪天有人只改了一边——那样用户会在树上看到一个
 * 名字,在磁盘上找到另一个。
 */

describe('sanitizeName', () => {
  it('把文件名里的非法字符换成下划线', () => {
    expect(sanitizeName('我的/项目:v1')).toBe('我的_项目_v1')
    expect(sanitizeName('a\\b*c?d"e<f>g|h')).toBe('a_b_c_d_e_f_g_h')
  })

  it('保留中文与常见符号', () => {
    expect(sanitizeName('数据看板 (深色版)-2026')).toBe('数据看板 (深色版)-2026')
  })

  it('超长截断到 50 字符', () => {
    expect(sanitizeName('久'.repeat(80))).toHaveLength(50)
  })

  it('空名字与全非法字符都有兜底', () => {
    expect(sanitizeName('')).toBe('design')
    expect(sanitizeName('   ')).toBe('   ') // 空格是合法文件名字符,不该被吃掉
  })
})

describe('exportDirName', () => {
  it('项目名 + 版本号', () => {
    expect(exportDirName('数据看板', 3)).toBe('数据看板-v3')
  })

  it('项目名缺失时用兜底名', () => {
    expect(exportDirName(undefined, 1)).toBe('design-v1')
  })

  it('非法字符先清洗再拼版本号', () => {
    expect(exportDirName('a/b', 12)).toBe('a_b-v12')
  })
})
