import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearPreviewError,
  pendingPreviewError,
  previewErrorPrompt,
  reportPreviewError
} from './errors'

/**
 * 这是模型唯一的"我写的东西跑不跑得起来"反馈来源,所以两件事要钉死:
 * 报得上去,以及**过期的报错不能再提**。
 *
 * 后者尤其容易写错:用户切回旧版本看到的报错,如果原样喂给下一轮,模型
 * 会去改一个根本没这个问题的新版本,越改越乱。
 */

const P = 'project-1'

beforeEach(() => clearPreviewError(P))

describe('上报与取用', () => {
  it('报上去就能取到', () => {
    reportPreviewError(P, 'v2', 'TypeError: x is not a function')
    expect(pendingPreviewError(P, 'v2')).toContain('TypeError')
  })

  it('没报过就是 null', () => {
    expect(pendingPreviewError(P, 'v2')).toBeNull()
  })

  it('项目之间互不干扰', () => {
    reportPreviewError(P, 'v2', '甲项目的错')
    expect(pendingPreviewError('project-2', 'v2')).toBeNull()
  })

  it('后报的覆盖先报的——只关心最近一次', () => {
    reportPreviewError(P, 'v2', '旧错误')
    reportPreviewError(P, 'v2', '新错误')
    expect(pendingPreviewError(P, 'v2')).toBe('新错误')
  })

  it('超长堆栈会截断,不把整个 prompt 撑爆', () => {
    reportPreviewError(P, 'v2', 'x'.repeat(50_000))
    expect(pendingPreviewError(P, 'v2')!.length).toBeLessThan(2000)
  })
})

describe('版本过期', () => {
  it('错误来自别的版本时不提——否则模型会去改一个没这问题的版本', () => {
    reportPreviewError(P, 'v1', '旧版本的错')
    expect(pendingPreviewError(P, 'v2')).toBeNull()
  })

  it('新版本落库后,旧错误自动失效,不需要谁去清', () => {
    reportPreviewError(P, 'v1', '错')
    expect(pendingPreviewError(P, 'v1')).not.toBeNull()
    // 模型改完 → 新版本 v2 落库 → 下一轮基线变成 v2
    expect(pendingPreviewError(P, 'v2')).toBeNull()
  })

  it('还没有任何版本时(第一次生成)不匹配版本,照常提示', () => {
    reportPreviewError(P, 'v1', '错')
    expect(pendingPreviewError(P, null)).toBe('错')
  })
})

describe('prompt 组装', () => {
  it('没有错误时不占位置', () => {
    expect(previewErrorPrompt(null)).toBe('')
  })

  it('带上原始错误,并要求优先修', () => {
    const out = previewErrorPrompt('TypeError: foo')
    expect(out).toContain('TypeError: foo')
    expect(out).toContain('优先修')
  })

  it('提醒行号不可信——报错位置是编译后的,对不上源文件', () => {
    expect(previewErrorPrompt('err')).toContain('search_files')
  })
})
