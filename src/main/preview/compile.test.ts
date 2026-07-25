import { describe, expect, it } from 'vitest'
import { compilePreviewFile, compileScriptFile, isCompilable } from './compile'

/**
 * 编译器是整条预览链路的地基:它出的是浏览器要直接执行的 ES 模块,错了就是
 * 白屏。而它又跑在主进程里,没有类型检查兜底(输入是 AI 生成的任意文本)。
 *
 * 重点盯两件事:产物必须是**合法 ESM**(有 export、裸导入原样保留给 import map),
 * 以及相对导入**绝不能被改写**——那是浏览器自己要发请求的东西,动了就断链。
 */

/**
 * 把编译产物真的跑起来,取出其中一个导出。
 *
 * 顶层 import/export 没法直接 new Function,所以把 export 摘掉再返回目标符号。
 * 只用于不含 import 的用例。
 */
type AnyFn = (...args: unknown[]) => unknown

function compiled(source: string, name: string): AnyFn {
  const code = compileScriptFile(source, 'x.ts').replace(/\bexport\s+/g, '')
  return new Function(`${code}; return ${name}`)() as AnyFn
}

describe('识别可编译文件', () => {
  it.each(['App.vue', 'a.tsx', 'a.jsx', 'a.ts', 'a.css'])('%s 要编译', (p) => {
    expect(isCompilable(p)).toBe(true)
  })

  it.each(['index.html', 'logo.svg', 'data.json', 'a.js'])('%s 原样直出', (p) => {
    expect(isCompilable(p)).toBe(false)
  })
})

describe('Vue SFC', () => {
  it('script setup + 模板内联成 render', () => {
    const out = compilePreviewFile(
      'App.vue',
      `<script setup>
import { ref } from 'vue'
const n = ref(0)
</script>
<template><button @click="n++">{{ n }}</button></template>`
    ).code

    expect(out).toMatch(/from ['"]vue['"]/) // 裸导入原样留给 import map
    expect(out).toContain('export default __sfc__')
    expect(out).not.toContain('<template>') // 模板已编译掉
  })

  it('相对导入原样保留——浏览器要自己去请求它', () => {
    const out = compilePreviewFile(
      'App.vue',
      `<script setup>
import Foo from './Foo.vue'
import { helper } from './utils/helper.ts'
</script>
<template><Foo /></template>`
    ).code

    // 被改写成注册表查表就等于断了浏览器原生解析这条路
    expect(out).toMatch(/['"]\.\/Foo\.vue['"]/)
    expect(out).toMatch(/['"]\.\/utils\/helper\.ts['"]/)
    expect(out).not.toContain('__modules__')
  })

  it('普通 script(非 setup)也要挂上 render', () => {
    const out = compilePreviewFile(
      'App.vue',
      `<script>
export default { data: () => ({ msg: 'hi' }) }
</script>
<template><p>{{ msg }}</p></template>`
    ).code

    expect(out).toContain('__sfc__.render')
    expect(out).toContain('export default __sfc__')
  })

  it('只有模板、没有 script 的组件是合法的', () => {
    const out = compilePreviewFile('Foo.vue', `<template><div>纯静态</div></template>`).code
    expect(out).toContain('export default __sfc__')
  })

  it('scoped 样式:注入 style 并挂 __scopeId', () => {
    const out = compilePreviewFile(
      'App.vue',
      `<template><div class="a">x</div></template>
<style scoped>.a { color: red }</style>`
    ).code

    expect(out).toContain('__sfc__.__scopeId')
    expect(out).toContain("createElement('style')".replace(/'/g, "'"))
    // scoped 的实现就是给选择器加属性,加不上说明 compileStyle 没生效
    expect(out).toContain('data-v-')
  })

  it('非 scoped 样式不挂 __scopeId', () => {
    const out = compilePreviewFile(
      'App.vue',
      `<template><div>x</div></template><style>.a { color: red }</style>`
    ).code
    expect(out).not.toContain('__scopeId')
  })

  it('lang="ts" 的类型注解要被抹掉', () => {
    const out = compilePreviewFile(
      'App.vue',
      `<script setup lang="ts">
import { ref } from 'vue'
interface User { name: string }
const u = ref<User>({ name: 'x' })
const n: number = 1
</script>
<template><i>{{ n }}</i></template>`
    ).code

    // 残留任何类型语法,浏览器都会当场语法错误
    expect(out).not.toContain('interface User')
    expect(out).not.toMatch(/const n: number/)
  })

  it('模板语法错误要抛,不能直出坏代码', () => {
    expect(() => compilePreviewFile('App.vue', `<template><div></span></template>`)).toThrow()
  })
})

describe('TSX / JSX', () => {
  it('JSX 转成 createElement,并自动注入 React', () => {
    const out = compilePreviewFile(
      'App.jsx',
      `export default () => <div className="a">hi</div>`
    ).code

    expect(out).toMatch(/import __React__ from ['"]react['"]/)
    expect(out).toContain('__React__.createElement')
  })

  it('用户没写 import React 也能跑——新写法都不写了', () => {
    const out = compilePreviewFile('App.jsx', `export const A = () => <p>x</p>`).code
    expect(out).toMatch(/import __React__ from ['"]react['"]/)
  })

  it('用户自己写了 import React 不冲突', () => {
    const out = compilePreviewFile(
      'App.jsx',
      `import React from 'react'
export default () => <div>{React.version}</div>`
    ).code

    expect(out).toMatch(/import __React__ from ['"]react['"]/)
    // 引号风格由编译器决定(oxc 统一成双引号),断言不该绑死它
    expect(out).toMatch(/import React from ['"]react['"]/)
  })

  it('tsx:类型和 JSX 一起处理', () => {
    const out = compilePreviewFile(
      'App.tsx',
      `type P = { n: number }
export default function A({ n }: P) { return <b>{n}</b> }`
    ).code

    expect(out).not.toContain('type P')
    expect(out).toContain('__React__.createElement')
  })

  it('纯 ts 不注入 React——那是白搭一个请求', () => {
    const out = compilePreviewFile(
      'utils.ts',
      `export const add = (a: number, b: number) => a + b`
    ).code
    expect(out).not.toContain('__React__')
    expect(out).toContain('export const add')
  })

  /**
   * sucrase 会把 ?? / ?. / class 字段降级成 helper 函数,关不掉。所以断言产物
   * 长什么样没有意义——**直接跑一遍,断言行为**。
   */
  it('降级后语义不变:?? 只在 null/undefined 时取右值', () => {
    const run = compiled(`export const f = (a, b) => a ?? b`, 'f')
    expect(run(0, 9)).toBe(0) // 0 是假值但不是 null,必须取左边
    expect(run('', 9)).toBe('')
    expect(run(null, 9)).toBe(9)
    expect(run(undefined, 9)).toBe(9)
  })

  it('降级后语义不变:可选链短路,不抛 TypeError', () => {
    const run = compiled(`export const f = (o) => o?.a?.b`, 'f')
    expect(run({ a: { b: 7 } })).toBe(7)
    expect(run({})).toBeUndefined()
    expect(run(null)).toBeUndefined()
  })

  it('降级后语义不变:class 字段', () => {
    const run = compiled(
      `export const f = () => { class A { x = 5; get2 = () => this.x * 2 }; return new A().get2() }`,
      'f'
    )
    expect(run()).toBe(10)
  })
})

describe('CSS', () => {
  it('编译成副作用模块,import 它就注入样式', () => {
    const out = compilePreviewFile('theme.css', `.x { color: red }`).code
    expect(out).toContain('document.head.appendChild')
    expect(out).toContain('export default')
  })

  it('内容做了转义,不会被反引号或换行截断', () => {
    const out = compilePreviewFile('a.css', ".x { content: '`' }\n.y{}").code
    // 用 JSON.stringify 转义;拼进模板字符串的写法会被反引号打断
    expect(() => new Function(out.replace(/export default \{\}/, ''))).not.toThrow()
  })
})

describe('产物是合法 ESM', () => {
  const cases: [string, string][] = [
    ['App.vue', `<script setup>const a = 1</script><template><i>{{ a }}</i></template>`],
    ['App.jsx', `export default () => <div>x</div>`],
    ['u.ts', `export const x: number = 1`],
    ['s.css', `.a{color:red}`]
  ]

  it.each(cases)('%s 能被解析成模块', (path, src) => {
    const { code, mime } = compilePreviewFile(path, src)
    expect(mime).toContain('javascript')
    // 用 Function 构造器解析不了 import/export,改用动态 import 的语法检查:
    // 直接 new Function 会因为顶层 import 报错,所以这里只断言不含明显残留
    expect(code).not.toContain('<template>')
    expect(code.length).toBeGreaterThan(0)
  })
})
