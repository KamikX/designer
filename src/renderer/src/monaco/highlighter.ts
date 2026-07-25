import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { shikiToMonaco } from '@shikijs/monaco'
import { monaco } from './setup'

/**
 * Shiki 接入 Monaco。
 *
 * 用纯 JS 正则引擎而不是 Oniguruma wasm:渲染层 CSP 是
 * `script-src 'self'`,Chromium 在指定 script-src 后实例化 WebAssembly
 * 需要额外的 'wasm-unsafe-eval'。只读高亮场景 JS 引擎完全够用,
 * CSP 一个字都不用动。forgiving 让个别 JS 不支持的 Oniguruma 语法
 * 降级跳过,而不是整份语法直接抛错。
 *
 * 选 Shiki 而不是 Monaco 自带的 Monarch,直接原因是 vue —— 它不是
 * Monaco 内置语言,但 Shiki 有对应的 TextMate 语法。
 */

/** 需要高亮的语言。id 必须先 register,shikiToMonaco 才会给它挂 tokenizer */
export const LANGS = [
  'html',
  'css',
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'vue',
  'json',
  'markdown'
] as const

export const LIGHT_THEME = 'vitesse-light'
export const DARK_THEME = 'vitesse-dark'

let ready: Promise<void> | null = null

/** 幂等:多个编辑器实例并发调用只会真正初始化一次 */
export function ensureHighlighter(): Promise<void> {
  ready ??= (async () => {
    const highlighter = await createHighlighterCore({
      themes: [import('shiki/themes/vitesse-light.mjs'), import('shiki/themes/vitesse-dark.mjs')],
      langs: [
        import('shiki/langs/html.mjs'),
        import('shiki/langs/css.mjs'),
        import('shiki/langs/javascript.mjs'),
        import('shiki/langs/typescript.mjs'),
        import('shiki/langs/jsx.mjs'),
        import('shiki/langs/tsx.mjs'),
        import('shiki/langs/vue.mjs'),
        import('shiki/langs/json.mjs'),
        import('shiki/langs/markdown.mjs')
      ],
      engine: createJavaScriptRegexEngine({ forgiving: true })
    })
    for (const id of LANGS) monaco.languages.register({ id })
    shikiToMonaco(highlighter, monaco)
  })()
  return ready
}

/** 跟随 antdv-next 的亮/暗切换 */
export function applyTheme(dark: boolean): void {
  monaco.editor.setTheme(dark ? DARK_THEME : LIGHT_THEME)
}
