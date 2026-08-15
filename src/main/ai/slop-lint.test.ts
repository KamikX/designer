import { describe, expect, it } from 'vitest'
import { lintArtifact, renderLint } from './slop-lint'

/**
 * 这个检查器的价值全在**误报率**上。
 *
 * 漏报只是少提醒一次;而误报会让模型去"修"一个本来就对的地方,把好设计改坏,
 * 而且它没法反驳——检查结果在它眼里是事实。所以这里正例(不该报的)比反例更重要。
 */

describe('抓得住的', () => {
  it.each(['快 10 倍', '效率提升 3 倍', '99.9% uptime', '10× faster'])('编造的数字:%s', (text) => {
    expect(lintArtifact('a.html', `<p>${text}</p>`).map((x) => x.rule)).toContain('invented-metric')
  })

  it.each(['lorem ipsum dolor', '功能一', '这里是描述'])('填充文案:%s', (text) => {
    expect(lintArtifact('a.html', `<p>${text}</p>`).map((x) => x.rule)).toContain('filler-copy')
  })

  it('外部占位图', () => {
    expect(
      lintArtifact('a.html', '<img src="https://images.unsplash.com/x">').map((x) => x.rule)
    ).toContain('remote-placeholder')
  })

  it('无豁免原文时,靛蓝要抓', () => {
    expect(lintArtifact('app.css', '.brand { color: #6366f1; }').map((x) => x.rule)).toContain(
      'ai-indigo'
    )
  })

  it('无豁免原文时,双色渐变要抓', () => {
    expect(
      lintArtifact('app.css', '.hero { background: linear-gradient(90deg, #8b5cf6, #06b6d4); }').map(
        (x) => x.rule
      )
    ).toContain('trust-gradient')
  })

  it.each([
    ['标题', '<h2>🚀 极速部署</h2>'],
    ['按钮', '<button>✨ 创建项目</button>']
  ])('无豁免原文时,%s里的 emoji 图标要抓', (_label, source) => {
    expect(lintArtifact('a.html', source).map((x) => x.rule)).toContain('emoji-icon')
  })

  it('全大写没加字距要抓', () => {
    expect(
      lintArtifact('app.css', '.k { text-transform: uppercase; letter-spacing: 0; }').map(
        (x) => x.rule
      )
    ).toContain('caps-no-tracking')
  })
})

/**
 * 豁免的判据是 StyleBrief 原文点名,不是"看起来像有意的"。
 * 后一种判据曾把整批视觉规则废掉——检查器判不了意图,只判得了文本。
 */
describe('StyleBrief 点名的元素豁免对应规则', () => {
  it('brief 点名靛蓝时不报 ai-indigo', () => {
    const findings = lintArtifact('app.css', '.brand { color: #6366f1; }', '品牌色是靛蓝系')
    expect(findings.map((x) => x.rule)).not.toContain('ai-indigo')
  })

  it('brief 写了色值本身也算点名', () => {
    const findings = lintArtifact('app.css', '.brand { color: #6366f1; }', '主色 #6366f1')
    expect(findings.map((x) => x.rule)).not.toContain('ai-indigo')
  })

  it('brief 点名渐变时不报 trust-gradient', () => {
    const findings = lintArtifact(
      'app.css',
      '.hero { background: linear-gradient(90deg, #8b5cf6, #06b6d4); }',
      '主视觉是紫蓝渐变'
    )
    expect(findings.map((x) => x.rule)).not.toContain('trust-gradient')
  })

  it('brief 点名 emoji 时不报 emoji-icon', () => {
    const findings = lintArtifact('a.html', '<h2>🚀 极速部署</h2>', '品牌语言使用 emoji 图标')
    expect(findings.map((x) => x.rule)).not.toContain('emoji-icon')
  })

  it('豁免是逐条的:点名渐变不连带豁免靛蓝', () => {
    const findings = lintArtifact('app.css', '.brand { color: #6366f1; }', '主视觉用渐变')
    expect(findings.map((x) => x.rule)).toContain('ai-indigo')
  })

  it('全大写字距是可读性规则,brief 不能豁免', () => {
    const findings = lintArtifact(
      'app.css',
      '.k { text-transform: uppercase; letter-spacing: 0; }',
      '标题全大写紧排'
    )
    expect(findings.map((x) => x.rule)).toContain('caps-no-tracking')
  })
})

describe('不该报的', () => {
  it('干净的产物一条都不报', () => {
    const good = `<section class="section"><div class="container">
      <p class="eyebrow">面向工程团队</p>
      <h1>把评审留在写代码的地方</h1>
      <p class="lead">评论、建议、批准都在同一处完成。</p>
    </div></section>`
    expect(lintArtifact('index.html', good)).toEqual([])
  })

  /** theme.css 就是放色值的地方,在那儿数 hex 等于惩罚正确做法 */
  it('theme.css 里的色值不算', () => {
    const theme = Array.from({ length: 30 }, (_, i) => `--c${i}: #a1b2c${i % 10};`).join('\n')
    expect(lintArtifact('theme.css', theme)).toEqual([])
  })

  it('正文里的 emoji 不算图标', () => {
    expect(lintArtifact('a.html', '<p>今天心情不错 🎉</p>')).toEqual([])
  })

  it('非前端文件不查', () => {
    expect(lintArtifact('README.md', '#6366f1 lorem ipsum 🚀')).toEqual([])
  })

  it('色值少于阈值时不报', () => {
    const few = Array.from({ length: 8 }, (_, i) => `#00000${i}`).join(' ')
    expect(lintArtifact('a.html', few).map((x) => x.rule)).not.toContain('raw-hex')
  })

  it('明确的全 sans 字体体系合法，不按字体类别告警', () => {
    const source = `
      h1 { font-family: Inter, ui-sans-serif, sans-serif; }
      body { font-family: Inter, ui-sans-serif, sans-serif; }
    `
    expect(lintArtifact('app.css', source)).toEqual([])
  })

  it('用户指定暖橙时不把单个颜色当成旧种子', () => {
    const findings = lintArtifact('brand.css', '.brand { color: #c96442; }')
    expect(findings.filter((finding) => finding.severity === 'P1')).toEqual([])
  })
})

describe('旧设计种子的组合指纹', () => {
  const legacyBrand = `
    --color-brand-500: #c96442;
    --color-brand-600: #b45a3b;
  `
  const legacySerif = `--font-display: 'Source Serif Pro', Georgia, serif;`
  const legacySpacing = `
    --spacing-section: 96px;
    --spacing-block: 56px;
    --spacing-gutter: 32px;
  `
  const legacyWarmSurface = `
    --color-bg: #faf9f7;
    --color-surface: #fdfcfa;
  `
  const legacyControls = `
    --radius-base: 10px;
    .btn { height: 44px; }
  `
  const legacyFeaturePairs = [
    ['品牌色', legacyBrand],
    ['暖表面', legacyWarmSurface],
    ['字体', legacySerif],
    ['间距', legacySpacing],
    ['控件', legacyControls]
  ].flatMap(([leftName, leftSource], index, features) =>
    features
      .slice(index + 1)
      .map(([rightName, rightSource]) => [
        `${leftName} + ${rightName}`,
        `${leftSource}\n${rightSource}`
      ])
  )

  it('旧品牌色组合与另外两类特征构成精确三类时报告', () => {
    const source = `
      @theme {
        ${legacyBrand}
        ${legacySerif}
        ${legacySpacing}
      }
    `

    const finding = lintArtifact('theme.css', source).find(
      (candidate) => candidate.rule === 'legacy-seed-fingerprint'
    )

    expect(finding).toMatchObject({
      severity: 'P1',
      message: expect.stringContaining('同时出现 3 类旧设计种子特征')
    })
    expect(finding?.snippet).toContain('#c96442')
  })

  it.each(legacyFeaturePairs)('任两类不报：%s', (_label, source) => {
    expect(lintArtifact('theme.css', `@theme { ${source} }`)).toEqual([])
  })
})

describe('给模型的措辞', () => {
  it('没问题时不占位置', () => {
    expect(renderLint([])).toBe('')
  })

  /*
   * 说"退步"而不是"建议"。后者会被当成可选意见,而模型对可选意见的默认反应
   * 是"我觉得现在挺好"。
   */
  it('措辞是确定的退步,不是风格建议', () => {
    const out = renderLint(lintArtifact('a.html', '<p>快 10 倍</p>'))
    expect(out).toContain('退步')
    expect(out).not.toContain('建议')
  })

  it('每条都带改法', () => {
    const out = renderLint(lintArtifact('a.html', '<p>快 10 倍</p>'))
    expect(out).toContain('改法')
  })

  it('分开统计必须修和应该修', () => {
    const out = renderLint(lintArtifact('a.html', '<p>快 10 倍</p>'))
    expect(out).toMatch(/\d+ 条必须修/)
  })
})
