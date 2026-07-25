/**
 * 内置技能:UI 设计体系规范。
 *
 * 这是全应用最硬的一条约束——不管做什么页面,都必须先有设计体系,再有页面。
 *
 * ## 为什么强制两段式
 *
 * 让模型直接画页面,它会一边写一边现编颜色:这里 #3b82f6、那里 #2563eb,
 * 圆角一会儿 8px 一会儿 12px。单看每一屏都还行,放到一起就是散的,而且
 * 用户想"把主色换成绿的"时无从下手——颜色散落在几十个类名里。
 *
 * 先把 token 定下来再画页面,换主题就变成改几行 theme.css。这也是我们
 * 能把主题可视化反馈给用户的前提:有个确定的地方可以读。
 *
 * ## token 结构的出处
 *
 * 语义分层(background / text / border 各自 primary-secondary-tertiary,
 * 外加 info-danger-success-warning)、三级字号 × 两种字重、有限的圆角与
 * 阴影档位,这套结构取自 Anthropic 公开的 MCP Apps 设计指南
 * (claude.com/docs/connectors/building/mcp-apps/design-guidelines)。
 *
 * **只借结构,不借配色**:那份文档里的具体色值是 Claude 的品牌色,拿来当
 * 本应用的默认调色板既不合适,产出的设计也会全都长成一个样。所以配色由
 * 模型按项目气质现场设计,规范只管住"必须成体系"。
 */

/** Tailwind v4 的 @theme 语法示例。给足示例比讲规则管用 */
const THEME_EXAMPLE = `
\`\`\`css
/* theme.css —— 设计体系的唯一定义处 */
@theme {
  /* 品牌色:按项目气质定,给出 50-900 的完整梯度 */
  --color-brand-50: #eef4ff;
  --color-brand-500: #4f6ef7;
  --color-brand-600: #3f57d6;
  --color-brand-900: #1b2560;

  /* 结构色:背景 / 文字 / 边框各自三级,深浅有别但同一色温 */
  --color-surface: #ffffff;
  --color-surface-muted: #f6f6f4;
  --color-surface-sunken: #efeeea;
  --color-ink: #17171a;
  --color-ink-muted: #4a4a52;
  --color-ink-subtle: #79797f;
  --color-line: #e6e5e1;
  --color-line-strong: #d2d1cc;

  /* 状态色:四个语义,各配一个浅底 */
  --color-success: #2f7d32;
  --color-success-bg: #e8f2e5;
  --color-warning: #8a6216;
  --color-warning-bg: #f7efdf;
  --color-danger: #a33a35;
  --color-danger-bg: #f7ecec;
  --color-info: #35619f;
  --color-info-bg: #e4ecf8;

  /* 圆角:一套有限档位,别每处现编 */
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;

  /* 字体 */
  --font-sans: ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* 暗色:只覆盖结构色与状态色,品牌梯度通常不用动。
   Tailwind v4 的工具类编译成 var(--color-*),所以这里覆盖变量即可生效 */
@media (prefers-color-scheme: dark) {
  :root {
    --color-surface: #1b1b1d;
    --color-surface-muted: #232326;
    --color-surface-sunken: #121214;
    --color-ink: #f2f1ee;
    --color-ink-muted: #bdbcb6;
    --color-ink-subtle: #8d8c87;
    --color-line: #34343a;
    --color-line-strong: #45454c;
  }
}
\`\`\`
`.trim()

export const DESIGN_SYSTEM_SKILL = `
# UI 设计体系规范(强制)

## 第一步永远是设计体系,不是页面

新项目的**第一轮**必须先产出 \`theme.css\`,把设计 token 定下来,然后才动页面。
已有 \`theme.css\` 的项目,后续所有页面一律复用它;要改风格就改 token,不要
在页面里写死颜色。

定 token 时先想清楚三件事,并在解说里告诉用户你的判断:

1. **这个产品的气质是什么** —— 冷静克制 / 温暖亲和 / 锐利专业 / 活泼年轻
2. **主色为什么是它** —— 与气质、行业惯例、目标人群的关系
3. **中性色的色温** —— 暖灰还是冷灰,这决定整体观感,比主色影响更大

${THEME_EXAMPLE}

## 设计体系要在画布上画出来,不只是写进 CSS

定完 token 之后,**第一个页面画的是设计体系本身**——一个可以直接预览的
规范页(html 栈叫 \`design-system.html\`,vue3/react 就是一个可切换到的视图)。
用户要能看见你定了什么,而不是去代码里翻 CSS 变量。这一页至少包含:

- **色板**:每个色组一行,色块 + token 名 + 色值;亮色暗色各一份
- **字号阶梯**:每一级用真实文案示范,标注 token 与字号
- **圆角与阴影**:各档位摆出实物方块
- **基础组件**:按钮(主/次/危险 × 默认/hover/禁用)、输入框、卡片、标签、
  空态——这些是后面每一页都要复用的,先在这里定型

这一页做完再做业务页面。它同时是给用户看的"设计交底",也是你自己后续
所有页面的取样板。

## token 之外不许出现颜色

页面里一律用 \`bg-surface\` \`text-ink\` \`border-line\` \`bg-brand-500\` 这样的类名。
**不允许**出现 \`bg-[#3b82f6]\` \`text-gray-500\` 这类写法——前者绕过了体系,
后者用的是 Tailwind 自带调色板而不是本项目的。

例外只有一处:纯装饰性的渐变、阴影里的半透明黑,可以写字面值。

## 排版:三级字号 × 两种字重

层级靠**字号 + 字重 + 颜色**三者配合,不要靠更多字号档位。

| 用途 | 字号 | 字重 | 颜色 |
| --- | --- | --- | --- |
| 标题 | text-xl / text-2xl / text-3xl | font-semibold | text-ink |
| 正文 | text-sm / text-base | font-normal | text-ink |
| 辅助 | text-xs / text-sm | font-normal | text-ink-muted |

一屏之内**最多三级**。想强调就换字重或颜色,不要再加一档字号。
行高:标题 1.1-1.25,正文 1.5-1.7。

## 间距:4 的倍数,成组呼吸

- 间距一律取 4 的倍数(Tailwind 的 1/2/3/4/6/8/10/12)
- **组内紧、组间松**:同一张卡片内元素间距 8-12px,卡片之间 16-24px,
  区块之间 32-48px。这个梯度是"看起来有结构"的主要来源
- 留白不是浪费。宁可少放内容,不要挤

## 圆角、边框、阴影:各自只用有限档位

- 圆角只用 theme 里定义的那几档;同一层级的元素必须同一档
- 边框优先 \`border-line\`,1px;需要强调才用 \`border-line-strong\`
- 阴影克制:卡片最多 sm,浮层才用 md 以上。**阴影和边框二选一**,
  同时上会显脏

## 状态必须齐全

每个交互元素都要有:默认 / hover / active / focus-visible / disabled。
focus-visible 一定要做——键盘用户全靠它。

每个数据区域都要考虑:有数据 / 空 / 加载中 / 出错。**空态不是一行灰字**,
要有图形(内联 SVG)、一句说明、一个可点的下一步。

## 暗色模式是必做项

\`theme.css\` 里必须有暗色覆盖。页面里不要写 \`dark:\` 变体去救火——
颜色都走 token 的话,暗色是自动的。

## 可访问性底线

- 正文与背景对比度 ≥ 4.5:1,大字号 ≥ 3:1(WCAG AA)
- 不能只靠颜色传达信息(状态要配图标或文字)
- 可点区域不小于 32×32,移动端 44×44
- 图片有 alt,图标按钮有 aria-label

## 图标

一律内联 SVG,单色描边(\`stroke="currentColor"\` \`fill="none"\`),
线宽 1.5-2,尺寸跟随字号。不要用 emoji 充当图标,不要引外部图标库。
`.trim()
