# 提示词与技能体系 v2 设计

> 参照 [nexu-io/open-design](https://github.com/nexu-io/open-design)(Apache-2.0,可改写引入其内容,保留出处)对本项目
> skills / craft / 提示词管线的重设计方案。调研基线:open-design 主干 + 本仓库 commit 3cf780d。
>
> **阅读提示:**本文主体记录基于旧提交的 v2 历史提案,其中 `resources/craft`、
> `design-templates`、单数 `target` 和部分拼装顺序并非当前实现。只有下面的“当前实现（权威）”
> 可作为维护依据;§0–§8 用于保留设计演进背景。

---

## 当前实现（权威）

- 项目 `styleBrief` 是整体视觉唯一事实来源,优先级为“用户本轮明确的全局风格 >
  项目 StyleBrief > 当前产物连续性 > skills 质量护栏”;局部修改不更新它。
- 设计技能仍位于 `resources/skills/`:端模板是 `target-*`,通用工艺是 `craft-*`;
  项目使用 `targets: DesignTarget[]` 支持多端,不是历史提案里的单数 `target`。
- `design-seed/references/theme-contract.md` 只定义语义 token 接口。项目 `theme.css`
  从 StyleBrief 生成;空 brief 且已有文件时延续当前视觉;首次空项目只有用户跳过后才使用
  项目内稳定、维度彼此独立且不持久化的 fallback。
- tools 模式只有“空 brief + 无文件”的首次项目由 VFS 闸门机械锁住写入;用户回答后先
  `set_style_brief`,跳过后才解锁 fallback。其他整体风格更新由 prompt 协议要求先
  `set_style_brief` 再写文件,局部修改不得调用该工具。
- markers 首次空项目的第一轮只在正文给出 2–3 个方向并等待,禁止输出文件;下一轮用户
  给出方向才使用 `<antdStyleBrief>`,明确跳过才使用 `<antdUseStyleFallback />`。
  收流后先持久化 StyleBrief,再提交暂存文件;失败不留下新主题或本轮文件,协议标记不进入
  VFS、artifact 或助手正文。

---

## 0. 一页结论

| 维度 | 调研时现状 | open-design 做法 | 当时 v2 决策 |
|---|---|---|---|
| 目录模型 | 单一 `skills/`,craft 与主题方法混在其中 | 四轴正交:skills(做事)/ design-templates(产物形状)/ design-systems(品牌)/ craft(通用工艺) | 收敛为**三轴**:`craft/`、`design-templates/`、`skills/`;当前不内置品牌主题,每项目由 StyleBrief 生成 `theme.css` |
| 平台维度 | **完全缺失**:无项目字段、无提示词分支、无预览视口 | `od.platform` + `metadata.kind` + `PLATFORM_CONTRACTS_BLOCK` + 按 kind 分叉的 metadata 块 | 项目新增 `target` 字段,注入平台契约块;预览面板加视口切换 |
| 提示词组织 | 段落顺序随意,lint/报错排在头部 | 缓存前缀纪律:稳定在前、逐轮可变在后、自检钉在最后 | 管线重排(§5) |
| 规则冲突 | 三套 token 命名互相打架;规则散落多处 | "一条规则只有一个家" + 显式优先级阶梯 | 统一 token 契约(§4)+ 宪章开篇写优先级阶梯 |
| 反 AI 味 | slop-lint 8 条 + craft-anti-slop,已有回流闭环 | 四层:负面清单 → linter → 自检 → 评审团;规则**二元化、可数化、现象化** | 保留闭环,升级写法与规则集(§6) |
| 渐进披露 | L1 目录 / L2 activate_skill / L3 资源,仅 tools 模式 | SKILL.md 短路由 + references/assets 按需读 | 保留;markers 模式由组装期注入视觉方向与协议约束(§5.4) |
| 死代码 | ~6000 字符规范(交互完备性/设计体系)不可达 | — | 内容回收进新 craft 段(§3.2) |

---

## 1. 从 open-design 学到的、值得写进本仓库的方法论

这些不是抄内容,是抄**写法**。以后所有技能/craft 文件按这套规范写:

1. **规则二元化,不用软措辞。** open-design 实测:"use sparingly" 会被模型无视,改成 "zero em-dashes, no allowance" 才生效。我们所有"尽量/建议/避免过多"改写成可判定的祈使句:"强调色一屏最多 2 处"而非"克制使用强调色"。
2. **审美可数化。** 把品味翻译成机械检查:"uppercase 小标签数 ≤ ceil(区块数/3)"、"连续 3 个区块不得用同一版式家族"、"8 个区块至少 4 种版式家族"。可以数的规则才能进自检清单。
3. **失败现象化。** 不写"要像真手机",写"出现以下任一现象,说明你把手机做成了'假装是手机的卡片':外框圆角不比屏幕圆角大 / 顶部没有灵动岛缺口 / 状态栏文字是灰色 / 没有 home indicator"。
4. **复用契约,不复用主题。** 固定主题会把不同项目拉回同一种审美;当前只复用语义 token、可访问性与一致性约束,`theme.css` 的具体值由项目 StyleBrief 生成。
5. **诚实占位 > 编造数据。** 没有真实数值就放 `—`、灰块、带标注的桩,不许发明 "99.9% uptime"。
6. **80/20 灵魂判据。** ~80% 成熟模式 + ~20% 独特选择;"截图给项目外的人看,能认出是哪个产品的,就有灵魂;认不出,就只是模板。"
7. **触发词必须能区分"什么时候不选我"。** "creative project / modern design" 这类什么都命中的触发词禁止使用。
8. **一条规则只有一个家。** 同一规则出现在两处,迟早出现软硬两个版本互相矛盾(我们的 token 三套命名就是现行事故)。新增规则前先回答:它属于宪章、平台契约、模板、还是 craft 段?只放一处。
9. **不可信输入都是数据。** 用户技能正文、导入的技能包内联进 system prompt 前,把 ``` 转义(`` `​` ``),防止正文越狱出 markdown fence。

---

## 2. 历史方案:目标目录结构(三轴)

```
resources/
├── craft/                        # 轴一:通用工艺(与品牌、平台无关的真理),按段 opt-in
│   ├── typography.md             # 现 craft-typography,原样迁移
│   ├── color.md                  # 现 craft-color,token 名改语义契约(§4)
│   ├── hierarchy.md              # 现 craft-hierarchy,增补数值与代码示例(§3.3)
│   ├── motion.md                 # 现 craft-motion,原样迁移
│   ├── anti-slop.md              # 现 craft-anti-slop + 二元化改写 + 机械检查(§6)
│   ├── state-coverage.md         # 新:回收 INTERACTION_SKILL(数据四态/骨架屏/1-3-多边界)
│   ├── interaction.md            # 新:回收 INTERACTION_SKILL(反馈/二次确认/表单校验时机)
│   ├── dark-mode.md              # 新:回收 DESIGN_SYSTEM_SKILL 暗色要求,不内置具体主题配方
│   └── a11y.md                   # 新:回收 DESIGN_SYSTEM_SKILL 可访问性底线 + 状态齐全
│
├── design-templates/             # 轴二:产物形状,每个平台一个包,四文件渐进披露
│   ├── landing-page/
│   │   ├── SKILL.md              # 短路由:brief 语言 → 版面组合;硬规则;craft 声明
│   │   ├── references/layouts.md # 现 design-seed/references/layouts.md(8 个版面本就是落地页向)
│   │   └── references/checklist.md
│   ├── mobile-app/
│   │   ├── SKILL.md              # archetype 路由表(Feed/详情/引导/表单/个人页/仪表)
│   │   ├── assets/frame.html     # 设备框种子:灵动岛/状态栏/home indicator/tab bar 一次画好
│   │   ├── references/layouts.md
│   │   └── references/checklist.md   # 含"假手机"现象清单
│   ├── admin-dashboard/
│   │   ├── SKILL.md              # 吸收 market:admin-list;密度即功能/tabular-nums/筛选-表格-分页
│   │   └── references/{layouts,checklist}.md
│   └── desktop-app/              # P2 再做:hover/键盘态/分栏/快捷键
│
└── skills/                       # 轴三:功能技能(对输入做事,而非渲染产物)
    └── design-seed/              # 生成方法、语义 token 契约、可访问性与一致性护栏;不含具体主题资产
```

- 用户技能来源(`~/.antd-designer/skills`、`~/.agents/skills`、`~/.claude/skills`)不变,`scan.ts` 增加对
  `resources/craft`、`resources/design-templates` 两个内置根的扫描。
- **design-systems 轴本期不做**:我们没有品牌包需求,项目 StyleBrief 承担整体视觉事实来源;但 `target` + 模板包的接口设计
  与 [[designer-cloud-saas-roadmap]] 对齐,云端版可在同一契约上加品牌包。

### 2.1 frontmatter 契约 v2

在现有 `name`/`description` 之上增加可选 `metadata` 命名空间(全部可选,缺省即现状,零破坏):

```yaml
---
name: mobile-app
description: 移动端 App 界面模板。触发:App、手机应用、iOS、Android、小程序风格的界面。不适用:落地页、中后台、桌面软件。
metadata:
  kind: template            # craft | template | skill(缺省 skill)
  platform: mobile          # mobile | desktop | responsive(画廊筛选 + target 匹配)
  craft: [typography, color, motion, state-coverage, anti-slop]   # opt-in 的 craft 段
  example-prompt: 做一个记账 App 的首页,支持分类统计
---
```

`scan.ts` 解析这些字段;未知字段忽略。`description` 按 §1.7 的规范重写:写清触发词**和**不适用场景。

---

## 3. 内容层设计

### 3.1 平台模板包怎么写(以 mobile-app 为范本)

SKILL.md 控制在 100 行内,只做五件事(照搬 open-design `design-templates/mobile-app` 的结构):

1. **资源地图**:ASCII 树列出包内文件、读取顺序、哪个 "先读"。
2. **第 0 步 pre-flight**:强制先读种子(`read_local_file assets/frame.html`),并说明为什么——
   "灵动岛、状态栏图标、home indicator、tab bar 都已经在种子里画好,不要每屏重画。"
3. **一张路由表**把自然语言 brief 映射到 archetype:

   | brief 里出现 | 用 |
   |---|---|
   | 信息流、消息、列表、动态 | A — Feed |
   | 文章、商品、歌曲、菜谱详情 | B — 详情页 |
   | 注册、欢迎、引导、开屏 | C — Onboarding |
   | 记账、打卡、统计、图表 | D — 仪表 |
   | 设置、我的、个人资料 | E — 个人页 |
   | 发布、填写、提交 | F — 表单 |

   随后一句约束:"**一屏只做一件事**。brief 像是两件事时,先交付一屏,另一屏作为后续提议。"
4. **硬规则**:极短祈使句 + 数字。"点击目标 ≥44px。" "强调色一屏 = 2 处。" "数字一律 `.num` 等宽。" "不引外链图片。"
5. **craft 声明** 放 frontmatter,不在正文重复 craft 内容(一条规则一个家)。

checklist.md 用 P0/P1/P2 分级,P0 必须全过才算完成,并包含现象化的"假手机"专段(§1.3)。

landing-page 与 admin-dashboard 同构:落地页的路由表按"页面节奏"(hero → 三栏特性 → 数据条 → 引言 → CTA
等版面家族的组合),中后台的路由表按"列表页/详情页/表单页/看板"。

### 3.2 死代码回收(P0,先做)

commit 3cf780d 把 `alwaysOn` 全关后,`design-system.ts`(4286 字符)与 `builtin-skills.ts` 的
INTERACTION_SKILL(1767 字符)成为无可达路径的死代码,其内容在 resources 下**无对应物**。处置:

| 死代码内容 | 去向 |
|---|---|
| 数据四态、骨架屏、边界数量 1/3/多 | `craft/state-coverage.md` |
| 交互反馈、二次确认、表单校验时机 | `craft/interaction.md` |
| 暗色模式要求 | `craft/dark-mode.md`;是否采用暗色及其具体 token 由 StyleBrief 决定 |
| 可访问性底线、hover/active/focus-visible/disabled 状态齐全 | `craft/a11y.md` |
| 响应式两断点 | 并入 `responsive` 平台契约块(§5.2) |
| 图标规范 | 并入 `craft/anti-slop.md`(emoji-icon 已有 lint 规则) |

迁移完成后**删除** `design-system.ts` 与 `builtin-skills.ts` 中的常量及 `skill:list-builtin` IPC 的引用。

### 3.3 craft/hierarchy 增补

现 947 字符全是抽象原则,撑不起一次 activate_skill。参照 craft-color 的写法增补:
层级差要"两个手段同向"给出具体档位表(字号 ×1.5 + 字重 -200 / 颜色 fg→muted + 字号 -2px);
"页面看着平"的三个成因各配一段 before/after CSS;加入可数检查("一屏只有一个视觉焦点;
数一下 font-weight ≥600 的元素,>3 个即层级失控")。

---

## 4. 统一 token 契约(P0,先做)

早期实现曾有三套 token 命名互相矛盾;当前 `design-seed/references/theme-contract.md` 只定义语义角色,
不携带任何固定色值、字号、间距或组件外观。具体 token 由每个项目的 StyleBrief 生成到 `theme.css`。

**当前已落地的颜色契约**:

```css
@theme {
  --color-bg / --color-surface / --color-raised / --color-sunken
  --color-ink / --color-ink-muted
  --color-line / --color-line-strong
  --color-brand-500 / --color-brand-600 / --color-focus
  --color-success / --color-warning / --color-danger / --color-info
}
```

- utility 使用同一语义:`bg-surface / text-ink / text-ink-muted / border-line / bg-brand-500`。
- `resources/skills/craft-color/SKILL.md`、`stacks.ts` COMMON_RUNTIME 与 `design-seed`
  的语义 token 契约保持同名;
  `theme.css` 是项目产物,由 StyleBrief 生成具体值,不得从内置资产复制主题。
- 是否提供暗色块由 StyleBrief 决定;`@import 'tailwindcss'` 仍由预览运行时注入方(`bootstrap.ts`)统一负责,
  导出时由 `artifact-export.ts` 补回 import,保证导出产物独立可用。

---

## 5. 提示词拼装管线 v2

### 5.1 宪章(改造 CRAFT_CORE,仍常驻 ≤1200 字符)

开篇即优先级阶梯(照搬 open-design 的宪法写法):

> 规则冲突时,列表靠前者胜:
> 1. 用户本轮明确的项目全局风格(原话是最高权威:"把整体主色改成深绿"= 更新项目 StyleBrief)
> 2. 项目 StyleBrief
> 3. 当前产物的视觉连续性
> 4. skills 的生成方法、可访问性与一致性等质量护栏

局部组件调整、单页例外或某个区块的临时风格不更新 StyleBrief。

其后保留现有 6 条底线 + 五维自评。宪章大小用测试卡死(参照 open-design 的 byte-budget 测试):
`tests/prompts/charter-budget.test.ts` 断言渲染后 ≤1200 字符,加不进去的内容必须移去模板/craft/契约块。

### 5.2 历史方案:单数 target 平台契约块

项目新增 `target: 'landing' | 'mobile' | 'admin' | 'desktop' | 'responsive'`(创建时选择,可留空)。
对应契约块只写**该平台不可妥协的交付标准**,与模板包不重复:

- **mobile**:真机框(圆角外框>屏幕圆角、灵动岛、home indicator)、44px 点击目标、一屏一事、拇指热区、tab ≤5。
- **landing**:一个 hero + 3–6 个区块、一种 CTA 语气、≥4 种版面家族、真实文案(禁 lorem 与编造数据)。
- **admin**:信息密度即功能、等宽数字、筛选-表格-分页三件套、数据四态齐全、无装饰。
- **desktop**:hover/focus-visible/键盘导航齐全、分栏布局、快捷键提示。
- **responsive**:360/768/1200 三点无横向滚动、断点处布局重排而非等比缩放。

`target` 为空时不注入契约块,但在会话文本命中平台信号(如中途说"改成手机 App")时,
把对应契约块追加到**可变区尾部**(不动稳定前缀,这是 open-design 的缓存纪律:触发源的稳定性决定注入位置)。

### 5.3 历史方案:拼装顺序 v2

现状把"上一版预览报错"和"lint 结果"排在第 3/4 段——既毁掉缓存前缀,又浪费了 recency 位。重排为:

| 区 | # | 段 | 说明 |
|---|---|---|---|
| **稳定前缀**(整个项目不变) | 1 | 身份 + 宪章(含优先级阶梯) | |
| | 2 | modeText + 技术栈 | |
| | 3 | 平台契约块 | target 创建时固定 → 稳定区 |
| | 4 | `## 当前产物模板` = 模板 SKILL.md 正文 | target 固定 → 随项目稳定,**不走 activate_skill**,组装期直接注入 |
| | 5 | `## 手艺参考` = 模板声明的 craft 段合集 | opt-in 解析:模板声明 ∪ 用户技能声明 |
| | 6 | 项目背景 description | |
| **会话稳定区** | 7 | 用户勾选技能全文(``` 转义) | |
| | 8 | 技能目录 L1 + 文件协议 + 本地范围 | |
| **逐轮可变区** | 9 | 当前设计稿文件树/文件 | |
| | 10 | 上一版预览报错 | 从头部移到这里 |
| | 11 | 反 AI 味 lint 结果 | 同上;"确定的退步"措辞保留 |
| | 12 | 收尾自检(五维 + 平台 checklist 引用) | **钉在最后**,吃 recency bias |

### 5.4 markers 模式回退(修复长尾模型零技能)

tools 模式中,只有空 brief 且无文件的首次项目由 VFS 闸门机械锁住写入。用户给出方向后
必须先成功调用 `set_style_brief` 才解锁;用户跳过后才解锁本轮 fallback。其他整体风格更新
仍由 prompt 协议要求先调用 `set_style_brief` 再写文件,不是全项目通用的机械闸门;
局部修改不得调用该工具。

`useTools=false` 时 L1/L2/L3 不可达,因此第 4/5 段仍由组装期注入。视觉方向不再内联固定主题:
有 StyleBrief 时直接注入原文;空 brief 且无文件时,本轮只在正文给出 2–3 个方向并等待下一轮,
禁止输出文件。用户下一轮给出方向才先输出 `<antdStyleBrief>`,明确跳过才先输出
`<antdUseStyleFallback />`,随后才能输出 `<antdFile>`;空 brief 但已有文件时延续当前产物视觉。
`<antdStyleBrief>` 必须先持久化,随后才提交文件;任一步失败都不留下新主题或本轮文件。
两个视觉协议标记只参与编排,不进入 VFS、artifact 或助手正文。

### 5.5 activate_skill 的角色变化

- 平台模板不再依赖模型主动激活(路由由 `target` 决定,消除模型漏加载平台方法的失败模式)。
- activate_skill 保留给:用户自装技能、`target` 为空的自由项目、以及跨平台补充包
  (如在 landing 项目里临时激活 mobile-app 看移动断点建议)。
- L1 目录里 `kind: template` 且已被 `target` 注入的条目**不再出现**(避免重复占预算)。

---

## 6. 反 AI 味体系升级

保留现有闭环(slop-lint → lint-store → 下一轮回流),按 open-design 升级三处:

### 6.1 anti-slop.md 改写

- 全部规则二元化(§1.1)。
- 新增**被禁调色板家族**:AI 最爱的"高级感"米杏色系(`#f5f1ea` 族背景 + 黄铜/赭石强调)整族列 hex 禁用,
  并加**轮换规则**:"上一个项目用了某个色系家族,本项目必须换一族"(需要 lint-store 记住上次的族)。
- 新增**默认字体禁令**:衬线体不得作为默认选择;"有创意/高级/杂志感"不是选衬线的理由。
- 新增机械检查:uppercase 小标签计数、版面家族重复度、`—` 破折号(中文语境改为:装饰性 `·` 中点、
  "01 / INDEX" 式区块编号、装饰性状态圆点、假产品截图 div)。

### 6.2 slop-lint.ts 扩展

- 新规则:`left-accent-card`(border-l-4 强调卡)、`accent-overuse`(强调色出现次数阈值)、
  `scroll-into-view`、米杏禁用色族、区块版式重复(同一 grid 模式连续 ≥3)。
- **按 target 挂平台规则**:mobile 产物跑"假手机"四项现象检查(外框圆角/灵动岛/状态栏透明度/home indicator,
  正则可查种子标记类名是否存活);landing 跑 eyebrow 计数与版面重复。
- 修覆盖面:lint 当前 artifact 的**全部文件**,不只本轮 writes(旧文件的问题现在永远查不到)。

### 6.3 自检流程

收尾自检段(管线 #12)增加两步:静态过一遍平台 checklist 的 P0 项;"两秒直觉检查"保留。
渲染预算写死一句(照搬):"一次预览渲染就是全部预算;失败后最多一次诊断,修完原因再重试。"

---

## 7. 顺手修的衔接问题

1. **市场双来源收敛**:市场"安装"一律走 `install_skill` 写文件系统(中文名转 slug,如
   `mobile-first`),不再写 DB;DB 技能保留只读兼容 + 一次性"导出为文件技能"按钮,
   兑现 `docs/skills-mcp-design.md` 里"文件是唯一事实来源"的既定方向。市场 6 条模板中,
   `mobile-first`/`admin-list` 的内容并入对应平台模板包后从市场下架。
2. **预览面板视口切换**:`PreviewPane.vue` 增加 375 / 768 / 1440 三档,按 `target` 选默认档;
   mobile 默认 375 并配深色背景衬托设备框。
3. **注入安全**:`skillsPrompt` 与模板正文内联处对 ``` 做零宽转义。
4. 清理:`clearLint`/`clearPreviewError` 接上调用点或删除;`SkillPanel.vue`/`skill.ts` 过期注释更正。

---

## 8. 历史分期路线

**P0 — 止血与地基(先行,独立可交付)**
死代码内容回收为 4 个新 craft 段(§3.2);token 契约统一(§4);每项目 `theme.css` 生成与运行时注入衔接;
管线重排 + markers 回退(§5.3/5.4);宪章加优先级阶梯 + budget 测试。

**P1 — 平台一等公民(本设计的主体)**
项目 `target` 字段 + 创建界面;平台契约块;`landing-page`/`mobile-app`/`admin-dashboard`
三个模板包(四文件结构);组装期模板注入;预览视口切换;frontmatter v2 解析。

**P2 — 打磨**
anti-slop 二元化改写 + lint 新规则 + 按 target 的平台 lint;desktop-app 模板;市场收敛;
craft/hierarchy 增补;`example-prompt` 进创建界面的"从示例开始"栏;调色板轮换记忆。

**可直接改写引入的 open-design 资产**(Apache-2.0,文件头注明出处):
`design-templates/mobile-app` 的 checklist 与设备框种子思路、`craft/state-coverage.md`
`form-validation.md` `accessibility-baseline.md` 的内容骨架、taste-skill §9 的 AI Tells 清单
(需本地化:英文文案味 → 中文文案味)、`core-slim.ts` 的宪章编辑守则。
