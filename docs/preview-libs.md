# 预览组件库(CDN 依赖)接入模式

> 项目勾选组件库 → 预览环境通过 import map 加载浏览器 ESM 构建 → AI 提示词放开对应
> import 许可。本文是**给下一个要接新库的人**的完整清单,首个落地样例是 antdv-next。

## 原理

预览 iframe 里没有打包器:vue3/react 的源文件在主进程编译成 ES 模块,由 `preview://`
协议直出;`import Foo from './Foo.vue'` 这类相对导入浏览器自己发请求回协议层,
`import { Button } from 'antdv-next'` 这类**裸导入**则靠 iframe 里的原生
**import map** 解析(`src/main/preview/bootstrap.ts`)。

所以"支持一个组件库" = 三件事:

1. **运行时**:import map 里把这个库(以及它的**全部裸依赖**)映射到可加载的
   ESM URL,样式文件(如有)注入 `<head>`;
2. **选择**:项目创建时可勾选,存进 `projects.libs`;
3. **提示词**:告诉模型这个库可用、怎么用、边界在哪。

## 接入清单(逐条过,漏一条就是断链)

### 1. 类型与存储

- `src/shared/types.ts`:`PreviewLib` 联合类型加新成员(用 npm 包名原文)。
- 存储无需改:`projects.libs` 是 JSON 数组,直接容纳新成员。

### 2. 创建界面

- `src/renderer/src/pages/home/components/CreateProjectModal.vue` 的 `LIB_OPTIONS`
  加一项(label + 一句话 hint)。
- 只对支持的栈显示(目前 `v-if="form.stack === 'vue3'"`);有依赖关系的包在
  `toggleLib` 里处理(如勾 icons 自动带上组件库本体)。

### 3. 预览运行时(核心)

`src/main/preview/bootstrap.ts`:

- 按 `project.libs` 生成额外的 import map 条目(`buildImportMap(extra)` 的口子
  就是为此留的),由 `protocol.ts` 的 `serveArtifact` 把 `project.libs` 传进来。
- **需要装配的库(样式加载、app.use)写一个 setup 虚拟模块**
  (`src/main/preview/lib-setup.ts`,参考 antdv-next-playground 的做法):
  统一契约 `export default async (app) => {}`,协议层按 `__setup__/<名字>.js`
  直出——不在产物文件树里,AI 和用户都看不见也改不坏;没勾的项目请求它
  直接 404。CSS 在 setup 里用 `<link>` + load/error 事件加载,CDN 挂了会
  报出具体 URL 走错误回流,而不是无声裸奔。只有裸导入、无需装配的库
  (如 icons)不用写 setup。
- **import map 必须覆盖库的整个裸依赖闭包**:浏览器解析到任何一个映射不到的
  裸导入就整个模块图失败。比如 antd 系组件库通常还要 `dayjs` 及其插件。
  确认方法:看目标库的浏览器构建里 `import` 了什么(或参考它官方 playground
  的 import map,antdv-next 参考 antdv-next-playground 仓库)。
- CSS:有独立样式文件的库要在引导 HTML 的 `<head>` 里注入 `<link>`(同样按
  勾选条件);CSS-in-JS 的库(antd 系新版)通常不需要。
- URL 两条路,按情况选:
  - **CDN**(默认):指到 jsdelivr/unpkg 等的 ESM 构建,锁定确切版本号
    (`@x.y.z`,不要 latest——预览的可复现性比新鲜度重要)。预览需要联网。
  - **vendor**(可选升级):跑 `scripts/prepare-preview-vendor.mjs` 把 ESM 文件
    落到 `resources/preview-vendor/`,import map 指 `preview://vendor/*`,零网络
    依赖,代价是安装包体积。vue/react 走的就是这条。
- `preview` scheme 已注册为 standard+secure,https 子资源可以直接加载,
  无需动 CSP。

### 4. 提示词

`src/main/ai/prompts/stacks.ts` 的 `LIB_PROMPTS` 加一段。写法纪律(和技能一致):

- 说清**允许什么**(import 语法示例)和**边界在哪**——组件库管"控件",
  版面/间距/配色仍归 Tailwind + theme.css,别让库的默认主题吃掉设计感;
- 主题衔接要写具体做法(如 ConfigProvider 的 colorPrimary 对齐 theme.css 的 brand);
- 规则写成可判定的祈使句,不写"建议合理使用"。

`stackPrompt(stack, libs)` 已按勾选拼接,调用点在 `prompts/index.ts`。

### 5. 导出提醒

导出的产物(`artifact-export.ts`)是源码文件,裸导入在用户自己的工程里要
`npm install` 对应的包。库对导出没有额外要求,但若某天加"导出成可独立打开的
html",要把 import map 一起写出去。

### 6. 验收

- 新建 vue3 项目勾上库 → 让 AI 生成一个用到该库组件的页面 → 预览正常渲染、
  控制台无模块解析错误;
- 不勾库的项目:提示词里不出现该库、import map 不含该库(模型如果越权 import,
  预览会报模块解析错误并回流,这是**故意的**——让它学会守边界);
- `pnpm typecheck && pnpm lint && pnpm vitest run`。

## 已接入的库

| 库 | 栈 | 方式 | 版本 | 备注 |
| --- | --- | --- | --- | --- |
| antdv-next | vue3 | CDN(jsdelivr) | 1.1.0 | `dist/antd.esm.js`;唯一裸依赖是 vue,dayjs(含 6 个插件)/cssinjs 全内联;CSS 走 `<link>`(reset.css + antd.css);引导脚本 `app.use` 全局安装 |
| @antdv-next/icons | vue3 | CDN(jsdelivr) | 1.0.4 | `dist/antd-icons.esm.js`;依赖全内联,零额外条目;全量 bundle 约 1.1MB |

antdv-next 的实测硬约束(来自 playground 调研,详见 bootstrap.ts 注释):
vue ≥ 3.5(bundle 用了 onWatcherCleanup)、antdv-next ≥ 1.0.4(更早没有 esm 构建)、
必须有 `window.process.env` shim(引导页已有)、**不要**给 dayjs 加映射(会出现
第二个实例)、子路径映射不补扩展名(`antdv-next/dist/locale/zh_CN.js` 可以,
去掉 `.js` 就 404)。

## 设计取舍备忘

- **为什么按项目勾选而不是全局开**:组件库直接改变产物形态(模型会倾向用现成
  控件),纯视觉稿项目不想要这种倾向;而且每多一个库,import map 与提示词都在
  为它付成本。
- **为什么锁版本**:预览产物要可复现;CDN 上的 latest 会让上个月的版本今天
  打不开。升级版本 = 改一处常量 + 回归验收。
- **为什么不给 html 栈**:html 栈直出用户文件、不注入 import map(用户页面里
  可能自带一个,一个文档两个 import map 直接报错)。

## Installed external npm libraries

External libraries are prepared offline by `src/main/libraries/service.ts`. Installation
includes the package root, manually configured subpaths, and concrete JavaScript subpaths
from the package's public `exports` map (including browser/import conditions). For example,
`tailwind-variants/lite` is bundled and mapped automatically when the package exports it.
Browser-incompatible automatic entries are omitted; explicit entries still fail installation
if they cannot be bundled. Wildcard exports and legacy paths require explicit subpaths.

The persisted `entries` map remains the source for both preview imports and the model's
available-import list. Existing installations must be refreshed with **Reinstall** in
Settings → Libraries to discover additional exports. A failed rebuild preserves the
previous prepared library. Reinstallation downloads dependencies and rebuilds the same
exact package version; transitive versions may change within their declared ranges.
