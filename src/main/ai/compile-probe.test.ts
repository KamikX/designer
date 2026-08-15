import { describe, expect, it } from 'vitest'
import { compileProbe } from './compile-probe'

describe('compileProbe', () => {
  it('健康的 SFC 通过', () => {
    const source = `<script setup lang="ts">
const message = 'hi'
</script>
<template>
  <div>{{ message }}</div>
</template>`
    expect(compileProbe('App.vue', source)).toBeNull()
  })

  it('script setup 语法错误要抓', () => {
    const source = `<script setup lang="ts">
const = broken
</script>
<template><div>x</div></template>`
    expect(compileProbe('App.vue', source)).toBeTruthy()
  })

  it('tsx 语法错误要抓', () => {
    expect(compileProbe('Widget.tsx', 'export const = () => <div/>')).toBeTruthy()
  })

  it('健康的 tsx 通过', () => {
    expect(compileProbe('Widget.tsx', 'export const W = () => <div>ok</div>')).toBeNull()
  })

  it('html 不走编译器,永远不报', () => {
    expect(compileProbe('index.html', '<div class="unclosed')).toBeNull()
  })

  it('错误文本截断,不把整页 codeframe 灌进工具结果', () => {
    const error = compileProbe('Widget.tsx', `const = 1\n${'x'.repeat(5000)}`)
    expect(error).toBeTruthy()
    expect(error!.length).toBeLessThanOrEqual(601)
  })
})
