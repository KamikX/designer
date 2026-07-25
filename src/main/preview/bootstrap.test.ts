import { describe, expect, it } from 'vitest'
import { buildBootstrapHtml } from './bootstrap'
import { libSetupSource } from './lib-setup'

/**
 * 组件库装配的三件事必须同时成立:import map 条目、CSS link、app.use 安装。
 * 漏任何一件的症状都是"预览白屏 + 一条模块解析错误",而且只在勾了库的项目上
 * 出现——回归起来很隐蔽,值得测试钉住。
 */

describe('buildBootstrapHtml 组件库装配', () => {
  it('vue3 + antdv-next:import map 条目 + setup 模块装配', () => {
    const out = buildBootstrapHtml('vue3', undefined, ['antdv-next'])
    expect(out).toContain('"antdv-next":')
    expect(out).toContain('/dist/antd.esm.js')
    // 装配走 setup 虚拟模块,引导页只负责 import 它并 await
    expect(out).toContain('./__setup__/antdv-next.js')
    // 尾斜杠前缀映射:子路径(locale 等)要能解析
    expect(out).toContain('"antdv-next/":')
  })

  it('setup 模块:样式带 load/error 检测 + app.use,没勾的项目拿不到(404)', () => {
    const code = libSetupSource('antdv-next.js', ['antdv-next'])
    expect(code).toContain('/dist/reset.css')
    expect(code).toContain('/dist/antd.css')
    expect(code).toContain('app.use(Antd)')
    expect(code).toContain('样式加载失败')
    // 守边界:没勾的项目请求 setup 直接 404
    expect(libSetupSource('antdv-next.js', [])).toBeNull()
    expect(libSetupSource('unknown.js', ['antdv-next'])).toBeNull()
  })

  it('icons 只加映射,不带 CSS 也不需要安装', () => {
    const out = buildBootstrapHtml('vue3', undefined, ['@antdv-next/icons'])
    expect(out).toContain('/dist/antd-icons.esm.js')
    expect(out).not.toContain('antd.css')
    expect(out).not.toContain('app.use')
  })

  it('没勾库的项目不注入任何装配,但带守边界的运行时检测', () => {
    const out = buildBootstrapHtml('vue3', undefined, [])
    // 装配三件套一件都不许有
    expect(out).not.toContain('antd.esm.js')
    expect(out).not.toContain('antd.css')
    expect(out).not.toContain('app.use')
    // 用了 a-* 组件时要报人话错误,而不是静默降级成普通元素
    expect(out).toContain('没有勾选 antdv-next 依赖包')
  })

  it('react 栈勾了也不生效(组件库只有 vue3 的运行时装配)', () => {
    const out = buildBootstrapHtml('react', undefined, ['antdv-next'])
    expect(out).not.toContain('antdv-next')
  })

  it('版本锁死,不出现 latest', () => {
    const out = buildBootstrapHtml('vue3', undefined, ['antdv-next', '@antdv-next/icons'])
    expect(out).not.toContain('@latest')
  })
})
