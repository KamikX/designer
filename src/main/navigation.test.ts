import { describe, expect, it } from 'vitest'
import { classifyAppNavigation } from './navigation'

describe('classifyAppNavigation', () => {
  it('开发环境只允许渲染器同源导航', () => {
    const current = 'http://localhost:5173/index.html#/collab'

    expect(classifyAppNavigation('/settings?tab=model', current)).toBe('internal')
    expect(classifyAppNavigation('http://localhost:5173/help', current)).toBe('internal')
    expect(classifyAppNavigation('//evil.example/path', current)).toBe('external')
    expect(classifyAppNavigation('https://example.com/docs', current)).toBe('external')
  })

  it('生产环境只允许当前 renderer 目录内的 file 导航', () => {
    const current =
      'file:///Applications/Designer.app/Contents/Resources/app.asar/out/renderer/index.html#/collab'

    expect(classifyAppNavigation('#/settings', current)).toBe('internal')
    expect(
      classifyAppNavigation(
        'file:///Applications/Designer.app/Contents/Resources/app.asar/out/renderer/help.html',
        current
      )
    ).toBe('internal')
    expect(classifyAppNavigation('file:///Users/test/private.html', current)).toBe('blocked')
  })

  it('仅把白名单外部协议交给系统，其余危险协议阻断', () => {
    const current = 'http://localhost:5173/'

    expect(classifyAppNavigation('HTTP://example.com', current)).toBe('external')
    expect(classifyAppNavigation('mailto:test@example.com', current)).toBe('external')
    expect(classifyAppNavigation('tel:+8610000', current)).toBe('external')
    expect(classifyAppNavigation('javascript:alert(1)', current)).toBe('blocked')
    expect(classifyAppNavigation('data:text/html,evil', current)).toBe('blocked')
    expect(classifyAppNavigation('designer-asset://asset/file', current)).toBe('blocked')
    expect(classifyAppNavigation('not a url', '')).toBe('blocked')
  })
})
