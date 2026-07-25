import { defineConfig } from 'vitest/config'

/**
 * 单测只覆盖纯逻辑模块(如 ai/file-stream-parser)。
 * 触碰 better-sqlite3 / electron 的模块不进 vitest——原生模块按
 * Electron ABI 编译,普通 node 加载不了,那些走应用内手工验证。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts']
  }
})
