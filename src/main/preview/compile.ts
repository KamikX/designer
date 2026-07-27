import { createHash } from 'crypto'
import { transformSync } from 'oxc-transform'
import { compileScript, compileStyle, compileTemplate, parse } from '@vue/compiler-sfc'

/**
 * 预览产物的编译:SFC / TSX / TS → 浏览器能直接跑的 ES 模块。
 *
 * ## 为什么放在主进程
 *
 * 以前 iframe 里塞了 vue3-sfc-loader(1.8MB)和 Babel(2.4MB),在浏览器里现编译;
 * React 那边还手写了一套 CommonJS require + 依赖爬取。两套东西解决的是同一个
 * 问题:**没有服务端,拿不到文件**。
 *
 * 但 preview:// 就是服务端。文件在主进程编译好直出成 ES 模块之后:
 *
 * - `import './Foo.vue'` 由浏览器自己发请求,不需要任何爬取和注册表代码
 * - 裸导入(vue / react)交给原生 import map,加依赖 = 加一行映射
 * - 拿到的是真模块:实时绑定、循环依赖、动态 import 全部按标准语义走
 *
 * @vue/repl 之所以要写 moduleCompiler 把相对导入重写成 `__modules__` 注册表、
 * 还要拓扑排序保证求值顺序,唯一原因就是它是纯浏览器应用没有服务端。我们有,
 * 所以那两块整个不需要。
 */

/** 编译结果。mime 固定是 JS——所有可编译的东西最终都以模块形式交付 */
export interface Compiled {
  code: string
  mime: string
}

/** 走编译的扩展名。其余(图片、json、html)按原样直出 */
const COMPILABLE = /\.(vue|tsx|jsx|ts|css)$/

export function isCompilable(path: string): boolean {
  return COMPILABLE.test(path)
}

/**
 * 编译单个文件。
 *
 * 出错一律抛异常,由协议层转成 500 + 错误文本;浏览器加载模块失败会触发
 * iframe 的 error 上报,最终显示到预览面板并回流给模型。
 */
export function compilePreviewFile(path: string, source: string): Compiled {
  if (path.endsWith('.vue')) return { code: compileSfc(source, path), mime: JS }
  if (path.endsWith('.css')) return { code: cssModule(source), mime: JS }
  return { code: compileScriptFile(source, path), mime: JS }
}

const JS = 'text/javascript; charset=utf-8'

/* ------------------------------------------------------------------ */
/* TS / JSX                                                            */
/* ------------------------------------------------------------------ */

/**
 * 用 oxc 而不是 Babel / sucrase。实测同一份 14KB 的 tsx:
 *
 * | 编译器 | 耗时 | 现代语法 |
 * | --- | --- | --- |
 * | sucrase | 2.32 ms | `?.` `??` class 字段一律降级成 helper |
 * | oxc | **0.17 ms** | **原样保留** |
 *
 * 快 13 倍还只是次要的——真正的差别是**不做多余的降级**。sucrase 关不掉那些
 * 转换,哪怕目标是原生支持它们的 Chromium;oxc 默认就照原样输出。
 *
 * oxc 是按平台分发的 N-API 预编译二进制。这在别处是个负担(PDF 那次为此换掉了
 * 原生方案),但这里不是:应用本来就带着 better-sqlite3,打包链路早就得处理原生
 * 模块;而 N-API 的 ABI 是稳定的,不需要 electron-rebuild。
 *
 * JSX 走 classic 运行时并把 pragma 指到一个内部名上:React 18 没有官方 ESM 的
 * jsx-runtime,而 classic 模式要求作用域里有 React——用户代码里未必写了
 * `import React`(新写法都不写了)。指到 __React__ 再由我们自己注入,两边都不用管。
 */
export function compileScriptFile(source: string, filename: string): string {
  const jsx = /\.[jt]sx$/.test(filename)
  const result = transformSync(filename, source, {
    jsx: {
      runtime: 'classic',
      pragma: '__React__.createElement',
      pragmaFrag: '__React__.Fragment',
      // 不加 __source / __self:那是给 React DevTools 用的,预览里没有 DevTools
      development: false
    }
  })
  if (result.errors.length) {
    throw new Error(result.errors.map((e) => e.message).join('\n'))
  }

  // 注入放在最前面。用户自己写的 `import React from 'react'` 不受影响——
  // 那是另一个绑定名,两者指向同一个模块实例
  return jsx ? `import __React__ from 'react'\n${result.code}` : result.code
}

/* ------------------------------------------------------------------ */
/* CSS                                                                 */
/* ------------------------------------------------------------------ */

/** `import './x.css'` 编译成一个副作用模块,和打包器的行为一致 */
function cssModule(source: string): string {
  return `${styleInjector(source)}\nexport default {}\n`
}

function styleInjector(css: string): string {
  return `;(function () {
  const el = document.createElement('style')
  el.textContent = ${JSON.stringify(css)}
  document.head.appendChild(el)
})()`
}

/* ------------------------------------------------------------------ */
/* Vue SFC                                                             */
/* ------------------------------------------------------------------ */

/** scopeId 用文件名哈希,和 vite-plugin-vue 一致:同一文件每次编译结果稳定 */
function hashId(filename: string): string {
  return createHash('sha256').update(filename).digest('hex').slice(0, 8)
}

/* ---------------- 源码位置注入(给预览标注用) ---------------- */

/**
 * 给模板里的每个普通元素加一个 `data-antd-src="App.vue:12:5"`。
 *
 * 为什么值得做:用户在预览里点中一个元素提需求时,模型只能拿到 DOM 特征
 * (标签、class、文本)去 search_files 猜位置,重复结构(v-for 出来的列表项、
 * 复用的卡片)必然猜歪。有了这一条,标注就是**精确坐标**。
 *
 * 只注入 vue3:html 栈渲染的就是源码本身,文本和 class 直接可搜;react 那边
 * prod 构建不透传 __source,没有等价的低成本注入点。
 */
const SRC_ATTR = 'data-antd-src'

/*
 * @vue/compiler-sfc 没把 compiler-core 的 NodeTypes / ElementTypes 枚举
 * re-export 出来(compiler-core 被打进了它的 dist,也不是我们的直接依赖),
 * 构造属性节点只能按枚举值写死。compile.test.ts 里那条断言是这几个数字
 * 唯一的防线——Vue 大版本升级时它会先炸,不要删。
 */
const NODE_ELEMENT = 1
const NODE_TEXT = 2
const NODE_ATTRIBUTE = 6
const TAG_PLAIN_ELEMENT = 0

interface TemplateNode {
  type: number
  tagType?: number
  props?: { name?: string }[]
  loc: { start: { line: number; column: number } }
}

/**
 * @param lineOffset 节点行号要加的偏移。
 *
 *   - `<script setup>` 走 compileScript 内联模板,拿到的 loc **已经是文件绝对行**,偏移为 0;
 *   - 普通 script 走 compileTemplate(source 是 template 块的内容),loc 相对块内容,
 *     要补上块的起始行 - 1。
 *
 * 两条路的口径不一样,这是最容易写错、且错了只表现为"AI 改错了行"的地方。
 */
function sourceLocTransform(filename: string, lineOffset: number) {
  return (node: TemplateNode): void => {
    if (node.type !== NODE_ELEMENT || node.tagType !== TAG_PLAIN_ELEMENT) return
    const props = node.props
    if (!props || props.some((p) => p.name === SRC_ATTR)) return
    const line = node.loc.start.line + lineOffset
    props.push({
      type: NODE_ATTRIBUTE,
      name: SRC_ATTR,
      nameLoc: node.loc,
      value: {
        type: NODE_TEXT,
        content: `${filename}:${line}:${node.loc.start.column}`,
        loc: node.loc
      },
      loc: node.loc
    } as never)
  }
}

function compileSfc(source: string, filename: string): string {
  const { descriptor, errors } = parse(source, { filename })
  if (errors.length) throw new Error(errors.map((e) => e.message).join('\n'))

  const id = hashId(filename)
  const scopeId = `data-v-${id}`
  const scoped = descriptor.styles.some((s) => s.scoped)
  const hasScript = !!(descriptor.script || descriptor.scriptSetup)
  // <script setup> 才能内联模板;普通 <script> 要单独编译模板再挂上去
  const inline = !!descriptor.scriptSetup

  const parts: string[] = []

  if (hasScript) {
    const script = compileScript(descriptor, {
      id,
      inlineTemplate: inline,
      genDefaultAs: SFC,
      templateOptions: inline
        ? {
            compilerOptions: {
              scopeId: scoped ? scopeId : null,
              // 内联模板的 loc 已经是文件绝对行,不用补偏移
              nodeTransforms: [sourceLocTransform(filename, 0)]
            }
          }
        : undefined
    })
    parts.push(script.content)
  } else {
    // 只有 <template> 的组件是合法的
    parts.push(`const ${SFC} = {}`)
  }

  if (!inline && descriptor.template) {
    const tpl = compileTemplate({
      id,
      filename,
      source: descriptor.template.content,
      scoped,
      compilerOptions: {
        scopeId: scoped ? scopeId : null,
        // source 是 template 块的内容,loc 从块内第 1 行起算
        nodeTransforms: [sourceLocTransform(filename, descriptor.template.loc.start.line - 1)]
      }
    })
    if (tpl.errors.length) {
      throw new Error(tpl.errors.map((e) => (typeof e === 'string' ? e : e.message)).join('\n'))
    }
    // render 改名再挂,避免和用户脚本里的同名变量撞车
    parts.push(tpl.code.replace(/\bexport function render\b/, `function ${RENDER}`))
    parts.push(`${SFC}.render = ${RENDER}`)
  }

  const css = descriptor.styles
    .map((style) => {
      const res = compileStyle({ id, filename, source: style.content, scoped: style.scoped })
      if (res.errors.length) throw new Error(res.errors.map((e) => e.message).join('\n'))
      return res.code
    })
    .join('\n')
  if (css.trim()) parts.push(styleInjector(css))

  if (scoped) parts.push(`${SFC}.__scopeId = ${JSON.stringify(scopeId)}`)
  parts.push(`${SFC}.__file = ${JSON.stringify(filename)}`)
  parts.push(`export default ${SFC}`)

  const code = parts.join('\n')
  // <script lang="ts"> 的类型注解会原样留在 compileScript 的产物里,
  // 这里统一再抹一遍。模板生成的代码本来就是 JS,过一遍没有副作用
  return isTs(descriptor) ? compileScriptFile(code, filename.replace(/\.vue$/, '.ts')) : code
}

const SFC = '__sfc__'
const RENDER = '__render__'

function isTs(descriptor: ReturnType<typeof parse>['descriptor']): boolean {
  const langs = [descriptor.script?.lang, descriptor.scriptSetup?.lang]
  return langs.some((lang) => lang === 'ts' || lang === 'tsx')
}
