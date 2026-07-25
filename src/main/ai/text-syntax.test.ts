import { describe, expect, it } from 'vitest'
import { checkSyntax } from './text-syntax'

/**
 * 检查器的第一要求是**不误报**:一条假错误会让模型去追一个不存在的问题,
 * 白烧好几轮工具调用。所以每组都先测"正常代码必须零问题"。
 */

describe('CSS', () => {
  it('正常样式零问题', () => {
    expect(
      checkSyntax('a.css', '@media (max-width: 600px) {\n  .hero { color: red; }\n}\n')
    ).toEqual([])
  })

  it('注释与字符串里的括号不参与配对', () => {
    expect(checkSyntax('a.css', '/* { 不算 */\n.a { content: "}"; }\n')).toEqual([])
  })

  it('少一个右花括号', () => {
    const [problem] = checkSyntax('a.css', '.hero {\n  color: red;\n')
    expect(problem.line).toBe(1)
    expect(problem.message).toContain('一直没有闭合')
  })

  it('多一个右花括号', () => {
    const [problem] = checkSyntax('a.css', '.hero { color: red; }\n}\n')
    expect(problem.line).toBe(2)
    expect(problem.message).toContain('多了一个')
  })
})

describe('JavaScript', () => {
  it('正常代码零问题', () => {
    const code = [
      'import x from "y"',
      '// 注释里的 { 不算',
      'const re = /[{]/g',
      'const s = `模板里的 ${x} 也不算`',
      'function go(a, b) {',
      '  return { a, b }',
      '}'
    ].join('\n')
    expect(checkSyntax('a.ts', code)).toEqual([])
  })

  it('除号不会被当成正则开头', () => {
    expect(checkSyntax('a.js', 'const half = (a + b) / 2\nconst c = { half }\n')).toEqual([])
  })

  it('括号类型对不上时指出开在哪一行', () => {
    const [problem] = checkSyntax('a.js', 'function go() {\n  const a = [1, 2\n}\n')
    expect(problem.message).toContain('第 2 行开的是 [')
  })

  it('少一个右花括号', () => {
    const problems = checkSyntax('a.js', 'function go() {\n  return 1\n')
    expect(problems).toHaveLength(1)
    expect(problems[0].line).toBe(1)
  })
})

describe('HTML', () => {
  it('正常页面零问题', () => {
    const html = [
      '<!doctype html>',
      '<html>',
      '<head><meta charset="utf-8"><title>t</title></head>',
      '<body>',
      '  <section class="hero">',
      '    <img src="a.png">',
      '    <br>',
      '    <ul><li>一<li>二</ul>',
      '  </section>',
      '</body>',
      '</html>'
    ].join('\n')
    expect(checkSyntax('index.html', html)).toEqual([])
  })

  it('省略闭合标签的元素不误报', () => {
    expect(checkSyntax('a.html', '<table><tr><td>x</table>\n')).toEqual([])
  })

  it('属性值里的 > 不会截断标签', () => {
    expect(checkSyntax('a.html', '<div data-tip="a > b"><span>x</span></div>\n')).toEqual([])
  })

  it('注释里的标签不算', () => {
    expect(checkSyntax('a.html', '<!-- <div> --><span>x</span>\n')).toEqual([])
  })

  it('script 内容里的 < 不当标签', () => {
    expect(checkSyntax('a.html', '<script>if (a < b) { go() }</script>\n')).toEqual([])
  })

  it('未闭合的区块被指出来', () => {
    const [problem] = checkSyntax('a.html', '<body>\n  <section>\n    <p>x</p>\n</body>\n')
    expect(problem.line).toBe(2)
    expect(problem.message).toContain('<section> 没有闭合')
  })

  it('孤立的闭合标签被指出来', () => {
    const [problem] = checkSyntax('a.html', '<span>x</span>\n</div>\n')
    expect(problem.message).toContain('没有对应的开始标签')
  })

  it('script 里的括号问题按页面行号报出', () => {
    const html = ['<body>', '<script>', 'function go() {', '</script>', '</body>'].join('\n')
    const [problem] = checkSyntax('a.html', html)
    expect(problem.line).toBe(3)
    expect(problem.message).toContain('没有闭合')
  })
})

describe('Vue SFC', () => {
  it('正常单文件组件零问题', () => {
    const sfc = [
      '<script setup lang="ts">',
      'const msg = ref("hi")',
      '</script>',
      '',
      '<template>',
      '  <div class="hero">{{ msg }}</div>',
      '</template>',
      '',
      '<style scoped>',
      '.hero { color: red; }',
      '</style>'
    ].join('\n')
    expect(checkSyntax('A.vue', sfc)).toEqual([])
  })

  it('模板里少一个闭合标签', () => {
    const sfc = ['<template>', '  <div class="hero">', '</template>'].join('\n')
    const [problem] = checkSyntax('A.vue', sfc)
    expect(problem.message).toContain('<div> 没有闭合')
  })
})

describe('JSON', () => {
  it('合法 JSON 零问题', () => {
    expect(checkSyntax('a.json', '{"a": [1, 2]}')).toEqual([])
  })

  it('非法 JSON 给出解析错误', () => {
    const [problem] = checkSyntax('a.json', '{"a": [1, 2}')
    expect(problem.message).toContain('JSON 解析失败')
  })
})

describe('其他类型', () => {
  it('认不出的类型不猜', () => {
    expect(checkSyntax('a.md', '# 标题 { 没闭合')).toEqual([])
    expect(checkSyntax('a.bin', '{{{')).toEqual([])
  })
})
