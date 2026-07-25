import type { CatalogSource, MarketMcp, MarketSkill } from './types'

/**
 * 内置清单。跟着版本发,零网络依赖。
 *
 * ## MCP 条目的取舍
 *
 * 只收**确认还在维护**的包。写这份清单时逐个查过 npm:
 *
 * - filesystem / memory / sequential-thinking:2026.7.x,活跃
 * - @playwright/mcp、context7:活跃
 * - server-github(2025.4.8)、server-postgres(0.6.2):一年多没动,**剔除**
 *
 * 这不是洁癖。"一键安装"装来一个跑不起来的东西,比没有这个入口更糟——用户
 * 会以为是我们的问题,然后去查一条根本不在我们这边的错误。
 */

const SKILLS: MarketSkill[] = [
  {
    id: 'market:mobile-first',
    name: '移动端优先',
    description: '先按 375px 设计,再向上适配;触控目标、安全区、横屏都兜住',
    tags: ['响应式', '移动端'],
    content: `# 移动端优先

## 断点顺序
先写 375px 的样式,再用 \`sm: md: lg:\` 向上覆盖。反过来(先桌面再压窄)几乎
总会在小屏上出现挤成一团的区域。

## 触控目标
可点区域不小于 44×44px。图标按钮看着小没关系,padding 撑到 44 即可——
视觉尺寸和点击尺寸是两回事。

## 必须处理的三件事
- **安全区**:\`env(safe-area-inset-bottom)\`,否则底部操作栏会被 Home 条压住
- **横屏**:高度受限时,垂直居中的弹层会顶出屏幕,改成顶部对齐 + 可滚动
- **输入法**:移动端弹起键盘会压缩视口,固定在底部的按钮会飞到中间`
  },
  {
    id: 'market:data-viz',
    name: '数据可视化规范',
    description: '图表选型、配色、坐标轴、空数据与极端值的处理',
    tags: ['图表', '看板'],
    content: `# 数据可视化

## 选型
- 比较大小 → 柱状图(不是饼图)
- 随时间变化 → 折线图
- 占比 → 只有 2-3 项时才用饼图,更多项用堆叠条
- **不要用 3D、不要用双 Y 轴**,两者都会让人读错

## 坐标轴
柱状图的 Y 轴**必须从 0 开始**,否则视觉差异会被放大数倍。折线图可以不从
0 开始,但要标注。

## 配色
分类数据用色相区分,连续数据用明度区分。同一张图里超过 7 种颜色就没人分得清了,
超出的归入"其他"。

## 别忘了这三种状态
- 无数据:给一句说明为什么空,不要只画个空坐标系
- 单个数据点:折线图画不出线,退化成一个带数值标签的点
- 极端值:一根柱子比其余高 100 倍时,给出截断标记而不是让其余全被压平`
  },
  {
    id: 'market:forms',
    name: '表单设计规范',
    description: '标签位置、校验时机、错误文案、长表单的分段与保存',
    tags: ['表单', '交互'],
    content: `# 表单设计

## 布局
标签放在输入框**上方**,不要左对齐放旁边——后者在窄屏上必然要换布局,而且
标签长度不一时右边缘参差不齐。

## 校验时机
- 输入过程中**不要**报错,那是在打断用户
- 失焦时校验单个字段
- 提交时校验全部,并把焦点移到第一个出错的字段

## 错误文案
说**怎么改**,不要只说错了:
- ❌ "格式不正确"
- ✅ "手机号应为 11 位数字,当前是 10 位"

## 长表单
超过 8 个字段就分段。分段之后要给进度指示,并且**允许中途离开**——
把已填内容存下来,不要让用户回来时面对一张空表。`
  },
  {
    id: 'market:admin-list',
    name: '中后台列表页',
    description: '筛选、分页、批量操作、列宽与空态的成套做法',
    tags: ['中后台', '表格'],
    content: `# 中后台列表页

## 筛选区
常用条件直接展开,其余收进"高级筛选"。筛选条件**要能从 URL 恢复**——
用户会把链接发给同事。

## 表格
- 关键列固定在左,操作列固定在右
- 长文本截断加 tooltip,不要撑宽整列
- 数字右对齐、文本左对齐,这样纵向扫读才快

## 批量操作
选中后在**表格上方**出现操作条,并显示"已选 N 项"。不要用悬浮在底部的
操作条遮住最后一行数据。

## 四种空态各不相同
- 从没有数据 → 引导创建
- 筛选后为空 → 提示放宽条件,并给"清空筛选"按钮
- 加载中 → 骨架屏,不是转圈
- 加载失败 → 说明原因 + 重试按钮`
  },
  {
    id: 'market:a11y',
    name: '无障碍检查清单',
    description: '对比度、键盘可达、焦点可见、语义标签、动效偏好',
    tags: ['无障碍', '规范'],
    content: `# 无障碍检查清单

## 对比度
正文对背景至少 4.5:1,大字号(18px 以上或 14px 粗体)至少 3:1。
**浅灰字配白底是最常见的违规**。

## 键盘
所有可交互元素都要能 Tab 到,顺序符合视觉顺序。焦点样式**不许直接
\`outline: none\`** ——要去掉默认样式就得自己画一个更清楚的。

## 语义
用 \`<button>\` 而不是可点击的 \`<div>\`。图标按钮要有 \`aria-label\`,
不然读屏只会念出一个空按钮。

## 动效
\`@media (prefers-reduced-motion: reduce)\` 里关掉位移和缩放类动画——
这类动效是前庭不适的常见触发源。

## 不要只靠颜色传达信息
"红色表示错误"对色觉障碍用户无效,配上图标或文字。`
  },
  {
    id: 'market:microcopy',
    name: '界面文案',
    description: '按钮、空态、错误、确认框的文案写法',
    tags: ['文案', '交互'],
    content: `# 界面文案

## 按钮
写**动作**,不写泛指:
- ❌ 确定 / 提交
- ✅ 保存草稿 / 删除这 3 个文件

确认框的按钮尤其要具体——用户常常只读按钮不读正文。

## 错误
三段式:发生了什么 → 为什么 → 现在能做什么。
"保存失败" 是废话,"保存失败:网络断开,内容已存在本地,恢复后会自动重试"
才是有用的。

## 空态
说明为什么空,并给下一步。不要只放一句"暂无数据"。

## 破坏性操作
确认框要说清**影响范围和可逆性**:"删除后无法恢复,该项目下的 12 个版本
会一并删除"。只写"确定删除吗"等于没说。

## 语气
陈述事实,不道歉、不卖萌。用户在赶工时不需要一个表情包。`
  }
]

const MCP: MarketMcp[] = [
  {
    id: 'market:mcp-filesystem',
    name: '文件系统',
    description: '让 AI 读写指定目录下的文件。范围由启动参数里的路径限定',
    tags: ['本地', '官方'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '<替换成你要开放的目录>'],
    homepage: 'https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem'
  },
  {
    id: 'market:mcp-memory',
    name: '长期记忆',
    description: '基于知识图谱的记忆,让 AI 跨会话记住实体和它们的关系',
    tags: ['记忆', '官方'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    homepage: 'https://www.npmjs.com/package/@modelcontextprotocol/server-memory'
  },
  {
    id: 'market:mcp-sequential',
    name: '结构化思考',
    description: '把复杂问题拆成可回溯的思考步骤,适合多步推理任务',
    tags: ['推理', '官方'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    homepage: 'https://www.npmjs.com/package/@modelcontextprotocol/server-sequential-thinking'
  },
  {
    id: 'market:mcp-context7',
    name: 'Context7 文档',
    description: '按需拉取第三方库的**最新**官方文档,避免模型用过时的 API',
    tags: ['文档', '开发'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    homepage: 'https://www.npmjs.com/package/@upstash/context7-mcp'
  },
  {
    id: 'market:mcp-playwright',
    name: 'Playwright 浏览器',
    description: '完整的浏览器自动化。比内置的网页操作更全,但要另起一个浏览器进程',
    tags: ['浏览器', '自动化'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest'],
    homepage: 'https://www.npmjs.com/package/@playwright/mcp'
  }
]

export const builtinCatalog: CatalogSource = {
  skills: async () => SKILLS,
  mcp: async () => MCP
}
