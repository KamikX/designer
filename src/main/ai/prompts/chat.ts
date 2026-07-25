/**
 * 纯聊天的系统提示词。
 *
 * ## 设计原则:默认什么都不说
 *
 * 设计模式那份提示词有近千字——身份、设计规范、文件协议、当前设计稿。那是
 * 必要的,因为它要产出可运行的多文件设计稿。
 *
 * 聊天不是。用户来这里就是想要一个干净的模型:问什么答什么,不预设它是谁、
 * 不规定输出格式、不塞设计规范。**没有任何要交代的事情时,这里返回空串,
 * chat-service 会整个不传 system**——行为和网页版聊天一致。
 *
 * 只有当用户主动打开了某个能力(授权目录、勾技能、开联网),才为那件事加一段,
 * 而且只说那件事。每一段都对应用户的一次显式操作,不存在"我没开却被塞了
 * 一堆规矩"的情况。
 */

export interface ChatPromptOptions {
  /** 已授权的本地范围说明,由 localScopePrompt 生成 */
  localScope?: string
  /** 是否开了联网搜索 */
  webSearch?: boolean
  /** 文件系统技能的目录(渐进披露的 L1),由 skills/catalog 生成 */
  skillCatalog?: string
}

const WEB_SEARCH = `
## 联网搜索

用户为这次对话开启了联网。你可以用 web_search 找资料、用 web_fetch 读具体页面。

- 先搜再读:web_search 只给标题和摘要,**摘要不足以回答问题时才 web_fetch**
  正文——每次抓取都要真的渲染一个页面,比搜索贵得多
- 涉及时效性的问题(版本号、价格、新闻、"最新的…")一律先搜,不要凭记忆答
- 引用信息时带上来源链接,让用户能自己核对
- 搜不到就说搜不到。**不要用记忆填补搜索的空白**,那比不搜更糟——用户以为
  这是刚查到的

### 操作网页

需要登录后才能看、要点进去才展开、要填表单才有结果的内容,用 browser_open
打开,再按快照里的编号点击和填写。

- 每个动作都会返回**新快照**,直接用返回里的编号,不要沿用上一轮的——页面
  重渲染之后旧编号可能指向别的东西
- 找不到目标元素时先 browser_scroll 滚一屏:很多内容滚到才渲染
- 表单用 browser_fill_form 一次填完,不要一个字段一次
- **不可逆的操作(提交订单、支付、删除、发送)在动手之前必须先 ask_user
  跟用户确认**。你没有撤销键
`.trim()

export function buildChatPrompt(options: ChatPromptOptions = {}): string {
  const sections = [
    // 勾选的技能只出现在目录里(渐进披露),不再有"全文注入"这条路
    options.localScope,
    options.skillCatalog,
    options.webSearch ? WEB_SEARCH : ''
  ].filter((section): section is string => !!section?.trim())

  return sections.join('\n\n')
}
