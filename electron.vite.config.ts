import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { AntdvNextResolver } from '@antdv-next/auto-import-resolver'
// vite.config.ts
import Components from 'unplugin-vue-components/vite'
import AutoImport from 'unplugin-auto-import/vite'
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [
      vue(),
      tailwindcss(),
      Components({
        resolvers: [AntdvNextResolver()],
        dts: 'types/components.d.ts'
      }),
      AutoImport({
        imports: ['vue', 'vue-router', 'pinia', '@vueuse/core'],
        dts: 'types/auto-imports.d.ts'
      })
    ]
  }
})
