/**
 * 产物的反 AI 味检查。
 *
 * ## 为什么是正则而不是解析 HTML
 *
 * 故意做得"糙":便宜、确定、加一条规则只要加一个正则。这里要抓的都是**字面
 * 特征**(某段占位文案、某个外部服务、某组属性组合),不需要理解文档结构。真去解析
 * DOM 反而会在半成品 HTML 上崩掉——而流式产出的中间态本来就经常不合法。
 *
 * ## 为什么要把结果喂回给模型
 *
 * 提示词里写"不要用靛蓝"只是**倾向**,模型仍然会用。而一条具体的
 * "第 12 行有 #6366f1" 是**事实**,它没法绕过去。
 *
 * 这条回流链路是"写完就结束"和"写完会被检查"的区别,也是我们相对纯提示词
 * 方案唯一的结构性优势。
 *
 * ## 审美类规则的豁免是查 StyleBrief 原文,不是查"意图"
 *
 * 靛蓝、双色渐变、emoji 图标可以是项目确认过的品牌语言。但"看起来也许是有意的"
 * 无法判定,曾经按这个思路把整批视觉规则删掉,结果模板味产出无人拦截。现在的
 * 判据是二元的:StyleBrief 文本里点名了该元素(词或色值)才豁免对应那一条,
 * 引用不出原文就报。全大写字距这类可读性规则与审美方向无关,永不豁免。
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
const AI_INDIGO = /#(6366f1|4f46e5|4338ca|3730a3|8b5cf6|7c3aed|a855f7|818cf8|c084fc)\b/i

/** 当图标用的 emoji。只查出现在标题/按钮/列表项里的 */
const SLOP_EMOJI = /[✨🚀🎯⚡🔥💡📈🎨🛡🌟💪🎉👋🙌✅⭐🏆🔮🌈]/u

/** 首屏的双色渐变 */
const TRUST_GRADIENT =
  /linear-gradient\([^)]*(?:#(?:6366f1|8b5cf6|a855f7|7c3aed)|purple|violet|indigo)[^)]*(?:blue|cyan|pink|#3b82f6|#06b6d4|#ec4899)/i

/** StyleBrief 点名靛蓝/紫系(词或色值)才豁免 ai-indigo */
const BRIEF_INDIGO = /靛|紫|indigo|violet|purple|#(6366f1|4f46e5|4338ca|3730a3|8b5cf6|7c3aed|a855f7|818cf8|c084fc)/i

/** StyleBrief 点名渐变才豁免 trust-gradient */
const BRIEF_GRADIENT = /渐变|gradient/i

/** StyleBrief 点名 emoji 才豁免 emoji-icon */
const BRIEF_EMOJI = /emoji|表情符?号?/i

/** 编造的指标 */
const INVENTED_METRIC =
  /(\b\d+\s*[×x]\s*(faster|better|more)|\b99\.\d+%\s*(uptime|可用)|快\s*\d+\s*倍|提升\s*\d+\s*倍|效率提升\s*\d+)/i

/** 填充文案 */
const FILLER = /(lorem ipsum|placeholder text|sample content|功能[一二三四]|这里是描述|标题文字)/i

/** 外部占位图服务 */
const REMOTE_PLACEHOLDER =
  /(unsplash\.com|placehold\.co|placekitten|picsum\.photos|via\.placeholder)/i

export function lintArtifact(path: string, source: string, styleBrief = ''): Finding[] {
  // 只查前端产物。theme.css 里出现色值是正常的
  if (!/\.(html|vue|tsx|jsx|css)$/.test(path)) return []

  const findings: Finding[] = []
  const isTheme = /theme\.css$/.test(path)

  const hit = (re: RegExp, f: Omit<Finding, 'snippet'>): void => {
    const m = re.exec(source)
    if (m) findings.push({ ...f, snippet: clip(m[0]) })
  }

  if (!BRIEF_INDIGO.test(styleBrief)) {
    hit(AI_INDIGO, {
      rule: 'ai-indigo',
      severity: 'P0',
      message: '用了 Tailwind 默认靛蓝,而 StyleBrief 没有点名这个色系。这是最可靠的"AI 生成"标记。',
      fix: '换成本项目 theme.css 里定义的品牌色 token。'
    })
  }

  if (!BRIEF_GRADIENT.test(styleBrief)) {
    hit(TRUST_GRADIENT, {
      rule: 'trust-gradient',
      severity: 'P0',
      message: '出现了紫/靛 → 蓝/粉的双色渐变,而 StyleBrief 没有点名渐变。',
      fix: '删掉渐变。一个平面配上有层次的字排,任何时候都比它强。'
    })
  }

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
  if (!BRIEF_EMOJI.test(styleBrief)) {
    const emojiAsIcon = /<(h[1-6]|button|li)[^>]*>[^<]{0,40}/gi
    for (const m of source.matchAll(emojiAsIcon)) {
      if (SLOP_EMOJI.test(m[0])) {
        findings.push({
          rule: 'emoji-icon',
          severity: 'P0',
          message: '拿 emoji 当功能图标,而 StyleBrief 没有点名 emoji。',
          fix: '换成 1.6–1.8px 描边的单线 SVG,stroke="currentColor"。',
          snippet: clip(m[0])
        })
        break
      }
    }
  }

  hit(REMOTE_PLACEHOLDER, {
    rule: 'remote-placeholder',
    severity: 'P1',
    message: '引了外部占位图服务。又脆又是明显的 AI 痕迹。',
    fix: '用 .ph-img 这类本地占位块。'
  })

  /*
   * 全大写没加字距。可读性规则,与审美方向无关,不看 StyleBrief。
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

  /*
   * 用了组件库却没定制主题。
   *
   * 只查 App.vue:config-provider 的正确位置就是根组件最外层,包在别处
   * 说明结构也有问题。子组件出现 <a- 标签而 App.vue 没包,控件就是默认蓝
   * ——所有项目长一个样的另一个源头。
   */
  if (/App\.vue$/.test(path) && /<a-[a-z]/.test(source) && !/config-provider/i.test(source)) {
    findings.push({
      rule: 'antd-unthemed',
      severity: 'P1',
      message: '用了 antdv-next 组件,但 App.vue 没有 a-config-provider 定制主题,控件是默认蓝。',
      fix: '最外层包 <a-config-provider :theme>，让 colorPrimary、字体、圆角与明暗按 StyleBrief 映射到 theme.css；实现方式见 antdv-theme 技能。',
      snippet: 'App.vue'
    })
  }

  /*
   * 旧设计种子是一整套母版，不是一枚暖橙色。用户可以合理地指定暖橙；只有同一文件
   * 同时继承了至少三类旧值，才值得判定为没有按项目生成主题。
   */
  const legacySeedFeatures = collectLegacySeedFeatures(source)
  if (legacySeedFeatures.length >= 3) {
    findings.push({
      rule: 'legacy-seed-fingerprint',
      severity: 'P1',
      message: `同时出现 ${legacySeedFeatures.length} 类旧设计种子特征，像是整套母版被原样沿用。`,
      fix: '回到 StyleBrief，重新生成本项目的字体、表面、尺度和组件几何；保留语义 token 接口，不复制旧视觉取值。',
      snippet: clip(legacySeedFeatures.map((feature) => feature.snippet).join(' ; '))
    })
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
不是风格意见——每一条都是机械核对出的事实,绕不过去。

${body}

先把这些修掉,再谈别的改动。
`.trim()
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat
}

interface LegacySeedFeature {
  snippet: string
}

/** 旧主题的判定必须是组合信号，避免把用户明确指定的单一颜色误报为模板。 */
function collectLegacySeedFeatures(source: string): LegacySeedFeature[] {
  const features: LegacySeedFeature[] = []
  const legacyBrand = /#c96442/i.exec(source)?.[0]
  const legacyBrandHover = /#b45a3b/i.exec(source)?.[0]
  if (legacyBrand && legacyBrandHover) {
    features.push({ snippet: `${legacyBrand} / ${legacyBrandHover}` })
  }

  const warmBackground = /#faf9f7/i.exec(source)?.[0]
  const warmSurface = /#fdfcfa/i.exec(source)?.[0]
  if (warmBackground && warmSurface) {
    features.push({ snippet: `${warmBackground} / ${warmSurface}` })
  }

  const sourceSerif = /Source Serif Pro/i.exec(source)?.[0]
  if (sourceSerif) features.push({ snippet: sourceSerif })

  const sectionSpacing = /(?:spacing-section|section)[^;{}]*:\s*96px/i.exec(source)?.[0]
  const blockSpacing = /(?:spacing-block|block)[^;{}]*:\s*56px/i.exec(source)?.[0]
  const gutterSpacing = /(?:spacing-gutter|gutter)[^;{}]*:\s*32px/i.exec(source)?.[0]
  if (sectionSpacing && blockSpacing && gutterSpacing) {
    features.push({ snippet: `${sectionSpacing} / ${blockSpacing} / ${gutterSpacing}` })
  }

  const buttonHeight = /height\s*:\s*44px/i.exec(source)?.[0]
  const baseRadius = /(?:radius-base|border-radius)\s*:\s*10px/i.exec(source)?.[0]
  if (buttonHeight && baseRadius) features.push({ snippet: `${buttonHeight} / ${baseRadius}` })

  return features
}
