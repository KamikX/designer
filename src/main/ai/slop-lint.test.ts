import { describe, expect, it } from 'vitest'
import { lintArtifact, renderLint } from './slop-lint'

/**
 * 这个检查器的价值全在**误报率**上。
 *
 * 漏报只是少提醒一次;而误报会让模型去"修"一个本来就对的地方,把好设计改坏,
 * 而且它没法反驳——检查结果在它眼里是事实。所以这里正例(不该报的)比反例更重要。
 */

describe('抓得住的', () => {
  it('Tailwind 默认靛蓝', () => {
    const f = lintArtifact('a.html', '<div style="color:#6366f1">x</div>')
    expect(f.map((x) => x.rule)).toContain('ai-indigo')
    expect(f[0].severity).toBe('P0')
  })

  it('双色信任渐变', () => {
    const f = lintArtifact('a.css', '.hero{background:linear-gradient(90deg,#8b5cf6,#06b6d4)}')
    expect(f.map((x) => x.rule)).toContain('trust-gradient')
  })

  it.each(['快 10 倍', '效率提升 3 倍', '99.9% uptime', '10× faster'])('编造的数字:%s', (text) => {
    expect(lintArtifact('a.html', `<p>${text}</p>`).map((x) => x.rule)).toContain('invented-metric')
  })

  it.each(['lorem ipsum dolor', '功能一', '这里是描述'])('填充文案:%s', (text) => {
    expect(lintArtifact('a.html', `<p>${text}</p>`).map((x) => x.rule)).toContain('filler-copy')
  })

  it('emoji 当图标', () => {
    expect(lintArtifact('a.html', '<h2>🚀 极速部署</h2>').map((x) => x.rule)).toContain(
      'emoji-icon'
    )
  })

  it('外部占位图', () => {
    expect(
      lintArtifact('a.html', '<img src="https://images.unsplash.com/x">').map((x) => x.rule)
    ).toContain('remote-placeholder')
  })

  it('全大写没加字距', () => {
    const f = lintArtifact('a.css', '.k{text-transform:uppercase;font-size:11px}')
    expect(f.map((x) => x.rule)).toContain('caps-no-tracking')
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

  it('全大写加够了字距就不报', () => {
    expect(lintArtifact('a.css', '.k{text-transform:uppercase;letter-spacing:0.08em}')).toEqual([])
  })

  it('emoji 出现在正文里不算——只有当图标用才算', () => {
    expect(lintArtifact('a.html', '<p>发布成功 🎉,可以去看看了</p>')).toEqual([])
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
  it('多个旧母版特征同时出现才报告，而不是只凭一个色值', () => {
    const source = `
      @theme {
        --color-bg: #faf9f7;
        --color-surface: #fdfcfa;
        --font-display: 'Source Serif Pro', Georgia, serif;
        --spacing-section: 96px;
        --spacing-block: 56px;
        --spacing-gutter: 32px;
        --radius-base: 10px;
      }
      .btn { height: 44px; }
    `

    const finding = lintArtifact('theme.css', source).find(
      (candidate) => candidate.rule === 'legacy-seed-fingerprint'
    )

    expect(finding).toMatchObject({
      severity: 'P1',
      message: expect.stringContaining('旧设计种子')
    })
    expect(finding?.snippet).toContain('#faf9f7')
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
    const out = renderLint(lintArtifact('a.html', '<div style="color:#6366f1">x</div>'))
    expect(out).toContain('退步')
    expect(out).not.toContain('建议')
  })

  it('每条都带改法', () => {
    const out = renderLint(lintArtifact('a.html', '<h2>🚀 x</h2>'))
    expect(out).toContain('改法')
  })

  it('分开统计必须修和应该修', () => {
    const out = renderLint(lintArtifact('a.css', '.k{text-transform:uppercase}'))
    expect(out).toMatch(/\d+ 条必须修/)
  })
})
