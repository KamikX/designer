import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { AntdvNextResolver } from '@antdv-next/auto-import-resolver'
import Components from 'unplugin-vue-components/vite'
import AutoImport from 'unplugin-auto-import/vite'
import dayjs from 'vite-plugin-dayjs'

// 自动生成的类型声明统一放在 src/renderer/types 下，只有 tsconfig.web.json 会引用它，
// 所以 antdv-next / vue / pinia / vue-router 这些全局声明只在渲染进程里生效。
const rendererTypes = (file: string): string => resolve('src/renderer/types', file)

export default defineConfig({
  // better-sqlite3 是原生模块，.node 二进制打不进 bundle，必须让它保持
  // 外部依赖在运行时 require。electron-vite 的 build.externalizeDeps
  // 默认就是 true，所以这里不用显式配（旧的 externalizeDepsPlugin 已废弃）。
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // 渲染层只允许从 shared 拿类型（契约层），不许伸手进 src/main
        '@shared': resolve('src/shared')
      }
    },
    plugins: [
      vue(),
      tailwindcss(),
      dayjs(),
      Components({
        // 只自动解析 antdv-next 的组件；项目自己的组件一律手动 import
        dirs: [],
        resolvers: [AntdvNextResolver({ resolveIcons: true })],
        dts: rendererTypes('components.d.ts')
      }),
      AutoImport({
        // 只自动导入第三方库的 API；项目自己的模块一律手动 import
        imports: ['vue', 'vue-router', 'pinia', '@vueuse/core'],
        vueTemplate: true,
        dts: rendererTypes('auto-imports.d.ts'),
        eslintrc: {
          enabled: true,
          filepath: rendererTypes('.eslintrc-auto-import.json'),
          globalsPropValue: 'readonly'
        }
      })
    ]
  }
})
