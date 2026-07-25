/**
 * 产物的反 AI 味检查。
 *
 * ## 为什么是正则而不是解析 HTML
 *
 * 故意做得"糙":便宜、确定、加一条规则只要加一个正则。这里要抓的都是**字面
 * 特征**(某个色值、某个 emoji、某个属性组合),不需要理解文档结构。真去解析
 * DOM 反而会在半成品 HTML 上崩掉——而流式产出的中间态本来就经常不合法。
 *
 * ## 为什么要把结果喂回给模型
 *
 * 提示词里写"不要用靛蓝"只是**倾向**,模型仍然会用。而一条具体的
 * "第 12 行有 #6366f1" 是**事实**,它没法绕过去。
 *
 * 这条回流链路是"写完就结束"和"写完会被检查"的区别,也是我们相对纯提示词
 * 方案唯一的结构性优势。
 */

export type Severity = 'P0' | 'P1'

export interface Finding {
  rule: string
  severity: Severity
  /** 给模型看的:哪里错了 */
  message: string
  /** 怎么改 */
  fix: string
  /** 命中的原文片段,截断 */
  snippet?: string
}

/** Tailwind 默认靛蓝一族。最可靠的 AI 标记 */
const AI_INDIGO = /#(6366f1|4f46e5|4338ca|3730a3|8b5cf6|7c3aed|a855f7|818cf8|c084fc)\b/gi

/** 当图标用的 emoji。只查出现在标题/按钮/列表项里的 */
const SLOP_EMOJI = /[✨🚀🎯⚡🔥💡📈🎨🛡🌟💪🎉👋🙌✅⭐🏆🔮🌈]/u

/** 编造的指标 */
const INVENTED_METRIC =
  /(\b\d+\s*[×x]\s*(faster|better|more)|\b99\.\d+%\s*(uptime|可用)|快\s*\d+\s*倍|提升\s*\d+\s*倍|效率提升\s*\d+)/i

/** 填充文案 */
const FILLER = /(lorem ipsum|placeholder text|sample content|功能[一二三四]|这里是描述|标题文字)/i

/** 首屏的双色渐变 */
const TRUST_GRADIENT =
  /linear-gradient\([^)]*(?:#(?:6366f1|8b5cf6|a855f7|7c3aed)|purple|violet|indigo)[^)]*(?:blue|cyan|pink|#3b82f6|#06b6d4|#ec4899)/i

/** 外部占位图服务 */
const REMOTE_PLACEHOLDER =
  /(unsplash\.com|placehold\.co|placekitten|picsum\.photos|via\.placeholder)/i

/** 标题用无衬线系统字体 */
const DISPLAY_SANS =
  /(?:^|\})\s*(?:h1|h2|\.h1|\.hero[\w-]*)[^{}]*\{[^}]*font-family\s*:\s*["']?(?:Inter|Roboto|Arial|system-ui|-apple-system)/im

export function lintArtifact(path: string, source: string): Finding[] {
  // 只查前端产物。theme.css 里出现色值是正常的
  if (!/\.(html|vue|tsx|jsx|css)$/.test(path)) return []

  const findings: Finding[] = []
  const isTheme = /theme\.css$/.test(path)

  const hit = (re: RegExp, f: Omit<Finding, 'snippet'>): void => {
    const m = re.exec(source)
    if (m) findings.push({ ...f, snippet: clip(m[0]) })
  }

  hit(new RegExp(AI_INDIGO.source, 'i'), {
    rule: 'ai-indigo',
    severity: 'P0',
    message: '用了 Tailwind 默认靛蓝。这是最可靠的"AI 生成"标记,一眼可辨。',
    fix: '换成本项目 theme.css 里定义的品牌色 token。'
  })

  hit(TRUST_GRADIENT, {
    rule: 'trust-gradient',
    severity: 'P0',
    message: '出现了紫/靛 → 蓝/粉的双色渐变。',
    fix: '删掉渐变。一个平面配上有层次的字排,任何时候都比它强。'
  })

  hit(INVENTED_METRIC, {
    rule: 'invented-metric',
    severity: 'P0',
    message: '出现了编造的数字。假数据会让整份产出失去可信度。',
    fix: '换成 — 或带标注的占位块;有真实来源时才写具体数值。'
  })

  hit(FILLER, {
    rule: 'filler-copy',
    severity: 'P0',
    message: '出现了填充文案。',
    fix: '空白区域是要用构图解决的设计问题,不是靠编字填满的。换个版面或写真实内容。'
  })

  // emoji 只在当图标用时才算问题,正文里出现无所谓
  const emojiAsIcon = /<(h[1-6]|button|li)[^>]*>[^<]{0,40}/gi
  for (const m of source.matchAll(emojiAsIcon)) {
    if (SLOP_EMOJI.test(m[0])) {
      findings.push({
        rule: 'emoji-icon',
        severity: 'P0',
        message: '拿 emoji 当功能图标。',
        fix: '换成 1.6–1.8px 描边的单线 SVG,stroke="currentColor"。',
        snippet: clip(m[0])
      })
      break
    }
  }

  hit(REMOTE_PLACEHOLDER, {
    rule: 'remote-placeholder',
    severity: 'P1',
    message: '引了外部占位图服务。又脆又是明显的 AI 痕迹。',
    fix: '用 .ph-img 这类本地占位块。'
  })

  hit(DISPLAY_SANS, {
    rule: 'display-sans',
    severity: 'P1',
    message: '标题硬写了无衬线系统字体。',
    fix: '标题用 theme.css 里的 --font-display;标题字体要和正文不同。'
  })

  /*
   * 全大写没加字距。
   *
   * 要把 letter-spacing 和 text-transform 放在同一条规则里看——分开查的话,
   * 一个定义在基类、一个定义在修饰类的正常写法会被误报。
   */
  for (const block of source.matchAll(/\{[^{}]*\}/g)) {
    const text = block[0]
    if (!/text-transform\s*:\s*uppercase/i.test(text)) continue
    const spacing = /letter-spacing\s*:\s*([\d.]+)em/i.exec(text)
    if (!spacing || Number(spacing[1]) < 0.06) {
      findings.push({
        rule: 'caps-no-tracking',
        severity: 'P1',
        message: '全大写没有加足够的字距(需要 ≥0.06em)。',
        fix: '加 letter-spacing: 0.08em。不加会挤成一团,是最可靠的业余标记。',
        snippet: clip(text)
      })
      break
    }
  }

  // theme.css 本来就是放色值的地方,不查
  if (!isTheme) {
    const hexes = source.match(/#[0-9a-f]{3,8}\b/gi) ?? []
    if (hexes.length > 12) {
      findings.push({
        rule: 'raw-hex',
        severity: 'P1',
        message: `出现了 ${hexes.length} 个字面色值,说明 token 没有被遵守。`,
        fix: '颜色一律用 theme.css 里的 token 类名,不要写死色值。'
      })
    }
  }

  return findings
}

/**
 * 组装成给模型的提醒。
 *
 * 措辞是有讲究的:说"这是退步"而不是"建议改进"。后者会被当成可选意见,
 * 而模型对可选意见的默认反应是"我觉得现在挺好"。
 */
export function renderLint(findings: Finding[]): string {
  if (findings.length === 0) return ''

  const p0 = findings.filter((f) => f.severity === 'P0')
  const body = findings
    .map(
      (f) =>
        `**[${f.severity}] ${f.rule}** —— ${f.message}\n  改法:${f.fix}` +
        (f.snippet ? `\n  命中:\`${f.snippet}\`` : '')
    )
    .join('\n\n')

  return `
## 上一版产物的检查结果

${p0.length} 条必须修,${findings.length - p0.length} 条应该修。这些是**确定的退步**,
不是风格意见——每一条都对应一个一眼可辨的"AI 生成"特征。

${body}

先把这些修掉,再谈别的改动。
`.trim()
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}
