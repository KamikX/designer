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
  eslintConfigPrettier
)
