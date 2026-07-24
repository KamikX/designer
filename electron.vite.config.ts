import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { AntdvNextResolver } from '@antdv-next/auto-import-resolver'
import Components from 'unplugin-vue-components/vite'
import AutoImport from 'unplugin-auto-import/vite'

// 自动生成的类型声明统一放在 src/renderer/types 下，只有 tsconfig.web.json 会引用它，
// 所以 antdv-next / vue / pinia / vue-router 这些全局声明只在渲染进程里生效。
const rendererTypes = (file: string): string => resolve('src/renderer/types', file)

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
        dirs: ['src/renderer/src/components'],
        extensions: ['vue'],
        resolvers: [AntdvNextResolver({ resolveIcons: true })],
        dts: rendererTypes('components.d.ts')
      }),
      AutoImport({
        imports: [
          'vue',
          'vue-router',
          'pinia',
          '@vueuse/core',
          {
            'antdv-next': [
              'message',
              'notification',
              'Modal',
              'theme',
              'useMessage',
              'useNotification',
              'useModal',
              'useForm',
              'useFormInstance',
              'useConfig',
              'useBreakpoint',
              'useResponsive',
              'useLayoutSider'
            ]
          }
        ],
        dirs: ['src/renderer/src/composables', 'src/renderer/src/stores'],
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
