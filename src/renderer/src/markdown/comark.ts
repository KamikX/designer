import { defineComarkComponent } from '@comark/vue'
import highlight from '@comark/vue/plugins/highlight'
import vitesseLight from 'shiki/themes/vitesse-light.mjs'
import vitesseDark from 'shiki/themes/vitesse-dark.mjs'

/**
 * 应用统一的 markdown 渲染器。
 *
 * 用 comark 而不是 markdown-it + 自己接高亮,理由只有一个但足够:它的
 * 解析器带 **auto-close**——流式到一半的 `**加粗`、没闭合的 ``` 围栏、
 * 半个组件标记,每一帧都能渲染出正确结构。自己拼的话,每次 chunk 到达
 * 都要处理"这段 markdown 还没写完"的问题,那是个坑很深的活。
 *
 * ## 高亮为什么正好合得上
 *
 * comark 的 highlight 插件内部就是 `createJavaScriptRegexEngine`——和
 * 我们为绕开 CSP(`script-src 'self'` 下实例化 wasm 需要
 * `'wasm-unsafe-eval'`)给 Monaco 选的引擎是同一个。所以接它进来
 * **CSP 一个字都不用改**。shiki 还是 peerDependency,用的是项目里这份。
 *
 * ## 两个 shiki 实例
 *
 * comark 的 highlighter 是它自己的单例,没有注入口;Monaco 那边要的是
 * `shikiToMonaco` 挂 tokenizer,这边要的是 `codeToTokens`,本来就是两种
 * 用法,合不到一起。能统一的是**主题**:两边都用 vitesse-light / dark,
 * 于是代码区和聊天里的代码块看起来是一套东西。
 *
 * 亮暗切换靠 shiki 的双主题 CSS 变量(`--shiki-dark*`),规则在
 * `MarkdownStream.vue` 的全局样式里。
 */
export const AppMarkdown = defineComarkComponent({
  name: 'AppMarkdown',
  plugins: [
    highlight({
      themes: { light: vitesseLight, dark: vitesseDark },
      // 要它给 <pre> 也带上前景/背景:关掉的话暗色下 --shiki-dark-bg
      // 根本不会出现在 pre 上,代码块底色就跟不了主题
      preStyles: true
    })
  ]
})
