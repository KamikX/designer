import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

/**
 * 单测只覆盖纯逻辑模块(如 ai/file-stream-parser)。
 * 触碰 better-sqlite3 / electron 的模块不进 vitest——原生模块按
 * Electron ABI 编译,普通 node 加载不了,那些走应用内手工验证。
 *
 * 别名要和 electron.vite.config.mts 里渲染层那份保持一致,否则渲染层的
 * 纯逻辑模块能构建、却测不了。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts']
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  }
})
