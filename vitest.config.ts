import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { AntdvNextResolver } from '@antdv-next/auto-import-resolver'
import Components from 'unplugin-vue-components/vite'
import AutoImport from 'unplugin-auto-import/vite'
import dayjs from 'vite-plugin-dayjs'

/**
 * 别名要和 electron.vite.config.mts 里渲染层那份保持一致,否则渲染层的
 * 组件测试复用 renderer 的自动导入约定，但关闭声明文件生成，避免跑测试
 * 改写工作区；Vue 插件只处理 renderer SFC，不影响主进程 Node 测试。
 */
export default defineConfig({
  plugins: [
    vue({ include: [/src\/renderer\/.*\.vue$/] }),
    dayjs(),
    Components({
      dirs: [],
      include: [/src\/renderer\/.*\.vue$/],
      resolvers: [AntdvNextResolver({ resolveIcons: true })],
      dts: false
    }),
    AutoImport({
      imports: ['vue', 'vue-router', 'pinia', '@vueuse/core'],
      // renderer store 也依赖 useStorage 等自动导入；范围仍不越过 renderer，
      // 因而不会把 Vue 全局注入主进程 Node 测试。
      include: [/src\/renderer\/.*\.[jt]sx?$/, /src\/renderer\/.*\.vue$/],
      vueTemplate: true,
      dts: false,
      eslintrc: { enabled: false }
    })
  ],
  test: {
    include: ['src/**/*.test.ts'],
    server: {
      // Antdv Next 的 picker 仍使用无扩展名 dayjs 插件导入，需交给上面的
      // dayjs resolver 处理；外置给原生 Node 会在 ESM 解析阶段提前失败。
      deps: { inline: [/antdv-next/, /@v-c/] }
    }
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  }
})
