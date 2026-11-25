import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const audit = (cases: { code: string; file: string; tests?: boolean }[]): string[][] =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import fs from 'node:fs'
    import { checkSource } from './scripts/i18n/check.mjs'
    const cases = JSON.parse(fs.readFileSync(0, 'utf8'))
    process.stdout.write(JSON.stringify(cases.map(({ code, file, tests }) => checkSource(code, file, tests))))
  `
      ],
      { input: JSON.stringify(cases), encoding: 'utf8' }
    )
  )

describe('localization source audit', () => {
  it('rejects Chinese keys, missing keys, and Chinese interpolation arguments', () => {
    const results = audit([
      { code: "t('保存')", file: 'src/renderer/src/example.ts' },
      { code: "translate('en-US', 'missing.key')", file: 'src/shared/example.ts' },
      { code: "t('common.exportedTo', '写死的文本')", file: 'src/renderer/src/example.ts' },
      { code: "console.error('未翻译')", file: 'src/main/example.ts' },
      { code: "promptText('en-US', 'missing.prompt')", file: 'src/main/example.ts' }
    ])
    for (const problems of results) expect(problems).toHaveLength(1)
  })

  it('checks Vue text, attributes, and expressions without touching comments', () => {
    const results = audit([
      {
        code: '<template><button title="未翻译">保存</button></template>',
        file: 'src/renderer/src/Example.vue'
      },
      {
        code: '<template><!-- 保留注释 --><button>{{ t("common.save") }}</button></template>',
        file: 'src/renderer/src/Example.vue'
      },
      {
        code: '// 保留注释\n/* 中文注释 */\nconst label = t("common.save")',
        file: 'src/renderer/src/example.ts'
      }
    ])
    expect(results[0]).toHaveLength(2)
    expect(results[1]).toEqual([])
    expect(results[2]).toEqual([])
  })

  it('allows only the documented recognition literals and preserves test data', () => {
    const results = audit([
      { code: "const mention = '@用户'", file: 'src/shared/group-mentions.ts' },
      { code: "const label = '其他中文'", file: 'src/shared/group-mentions.ts' },
      { code: "const sample = '用户的中文数据'", file: 'src/shared/example.test.ts', tests: true },
      { code: "t('保存')", file: 'src/shared/example.test.ts', tests: true },
      {
        code: 'const injected = `// 保留注释\nconsole.log("untranslated 中文")`',
        file: 'src/main/preview/bootstrap.ts'
      }
    ])
    expect(results[0]).toEqual([])
    expect(results[1]).toHaveLength(1)
    expect(results[2]).toEqual([])
    expect(results[3]).toHaveLength(1)
    expect(results[4]).toHaveLength(1)
  })

  it('requires matching dictionaries and interpolation placeholders', () => {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import { checkDictionaries } from './scripts/i18n/check.mjs'
      process.stdout.write(JSON.stringify(checkDictionaries(
        { 'common.good': 'Good {0}', 'common.missing': 'Missing', '中文': 'Bad' },
        { 'common.good': '好的 {1}', '中文': '中文' }, 'Test'
      )))
    `
        ],
        { encoding: 'utf8' }
      )
    ) as string[]
    expect(result).toHaveLength(3)
    expect(result.some((problem) => problem.includes('mismatched placeholders'))).toBe(true)
    expect(result.some((problem) => problem.includes('missing EN/CN'))).toBe(true)
    expect(result.some((problem) => problem.includes('invalid translation key'))).toBe(true)
  })
})
