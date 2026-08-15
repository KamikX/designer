import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'

// 自动导入的全局变量（vue / vue-router / pinia / @vueuse/core / antdv-next）
// 只对渲染进程开放，主进程和 preload 里使用会照常报 no-undef。
const autoImportRc = fileURLToPath(
  new URL('./src/renderer/types/.eslintrc-auto-import.json', import.meta.url)
)
const autoImportGlobals = existsSync(autoImportRc)
  ? JSON.parse(readFileSync(autoImportRc, 'utf-8')).globals
  : {}

export default defineConfig(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      // 预览运行时的第三方 vendor 大文件（babel/vue/react/tailwind），不 lint
      'resources/**',
      // 合成基准 fixture:刻意保留超长行与压缩写法,lint 会把压力场景"修好"
      'src/main/ai/fixtures/**',
      // 截图冒烟的临时 bundle(scripts/capture-smoke-build.mjs 生成,入口必须
      // 落在项目根,见该脚本注释)
      '.capture-smoke*.cjs',
      'src/renderer/types/auto-imports.d.ts',
      'src/renderer/types/components.d.ts'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        },
        extraFileExtensions: ['.vue'],
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['src/renderer/**/*.{ts,mts,tsx,vue}'],
    languageOptions: {
      globals: autoImportGlobals
    }
  },
  {
    files: ['**/*.{ts,mts,tsx,vue}'],
    rules: {
      'vue/require-default-prop': 'off',
      'vue/multi-word-component-names': 'off',
      'vue/block-lang': [
        'error',
        {
          script: {
            lang: 'ts'
          }
        }
      ]
    }
  },
  {
    // 构建脚本是纯 .mjs，套用应用代码的类型规则没有意义——那里写不了类型注解
    files: ['scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  eslintConfigPrettier
)
