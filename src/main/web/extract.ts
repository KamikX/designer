/**
 * 注入进页面里执行的取值脚本。
 *
 * 写成字符串常量而不是函数再 toString():后者经过打包器的压缩和 helper 注入
 * 之后,注入的内容和源码可能对不上,出问题极难查。字符串是所见即所得。
 *
 * 这些脚本在**不受信任的页面**里运行,所以只读 DOM、不引外部代码、不回传
 * 除文本以外的东西。
 */

/** 正文之外的东西。这些几乎不含用户要的信息,却占了大半篇幅 */
const NOISE = [
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[aria-hidden="true"]'
].join(',')

/**
 * 正文提取(defuddle 版)。
 *
 * ## 为什么不自己写启发式
 *
 * 手写的"找 article / 按文本密度猜"在新闻页上还行,在文档站、GitHub、SPA 上
 * 基本失效。defuddle 是多轮提取:第一轮标准不达标就放宽再来,而不是像
 * Readability 那样单轮打分、不达标直接返回 null——后者正是文档站抽出来空白
 * 的主因。它还自带站点专用提取器,并且直接输出 markdown。
 *
 * ## 必须在**活文档**上跑,不能 clone
 *
 * Readability 的 parse() 会破坏 DOM,所以官方要求传 cloneNode(true)。defuddle
 * 反过来——它**读页面的 computed style**(拿移动端样式规则判断哪些是页面框架、
 * 哪些是正文),而游离的克隆节点没有样式关联,一 clone 就把它最强的信号废掉了。
 *
 * 我们的窗口本来就是用完即毁的,DOM 被改无所谓。
 */
export const EXTRACT_ARTICLE = `(async () => {
  if (typeof Defuddle === 'function') {
    try {
      // 页内看门狗:defuddle 在个别巨型页面上会跑不完。8 秒没出结果就放弃,
      // 落到下面的启发式兜底——拿到次优正文,好过外层超时后什么都没有
      const r = await Promise.race([
        new Defuddle(document, { url: location.href, markdown: true }).parse(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('defuddle timeout')), 8000))
      ])
      const body = (r.contentMarkdown || r.content || '').trim()
      // 词数少得不合理时判为提取失败,交给下面的兜底。空字符串同理
      if (body && (r.wordCount == null || r.wordCount >= 50)) {
        return {
          url: location.href,
          title: (r.title || document.title || '').trim(),
          text: body,
          author: r.author || '',
          published: r.published || '',
          via: 'defuddle'
        }
      }
    } catch (e) {
      // 提取器自己炸了不该让整次抓取失败,落到兜底
    }
  }
  return __fallbackExtract()
})()`

/** defuddle 失败时的兜底:原来那套语义标签 + 文本密度启发式 */
export const FALLBACK_EXTRACT = `window.__fallbackExtract = () => {
  const NOISE = ${JSON.stringify(NOISE)}
  const clean = (root) => {
    const copy = root.cloneNode(true)
    copy.querySelectorAll(NOISE).forEach((el) => el.remove())
    return copy
  }
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\n{3,}/g, '\\n\\n').trim()

  let target = document.querySelector('article, main, [role="main"]')
  if (!target) {
    // 按文本量挑一个块。只看直接候选,不做递归——递归到最后总会选中 body
    const candidates = [...document.querySelectorAll('div, section')]
    let best = null
    let bestLen = 0
    for (const el of candidates) {
      const len = (el.textContent || '').length
      if (len > bestLen) { best = el; bestLen = len }
    }
    target = best || document.body
  }

  return {
    url: location.href,
    title: (document.title || '').trim(),
    text: textOf(clean(target)),
    author: '',
    published: '',
    via: 'fallback'
  }
}`

/**
 * 搜索结果提取(DuckDuckGo)。
 *
 * 三套选择器依次试:新版 SPA 的 data-testid、老的 html 端点、以及最后的
 * 兜底扫链接。搜索引擎改版是常态,写死一套迟早某天静默返回空。
 *
 * `blocked` 单独回传:**"没搜到"和"被拦住了"必须区分**。前者是正常结果,
 * 后者要告诉用户去换搜索源,混为一谈的话用户只会觉得"这功能不好使"。
 */
export const EXTRACT_RESULTS = `(() => {
  const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '')
  const pick = (root, sels) => { for (const s of sels) { const el = root.querySelector(s); if (el) return el } return null }

  const groups = [
    { item: '[data-testid="result"]', title: ['[data-testid="result-title-a"]', 'h2 a', 'a'], snippet: ['[data-testid="result-snippet"]', '[data-result="snippet"]'] },
    { item: '.result, .results_links', title: ['.result__a', 'h2 a', 'a'], snippet: ['.result__snippet'] }
  ]

  for (const g of groups) {
    const nodes = [...document.querySelectorAll(g.item)]
    if (!nodes.length) continue
    const hits = nodes.map((n) => {
      const a = pick(n, g.title)
      return { title: text(a), url: a && a.href ? a.href : '', snippet: text(pick(n, g.snippet)) }
    }).filter((h) => h.url && h.title)
    if (hits.length) return { hits, blocked: false }
  }

  // 一条都没抽到:是真没结果,还是被验证码/风控挡了?
  const body = (document.body ? document.body.innerText || '' : '').toLowerCase()
  const blocked = /captcha|unusual traffic|are you a robot|verify you are human|访问被拒绝|人机验证/.test(body)
  return { hits: [], blocked }
})()`
