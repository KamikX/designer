import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'

const require = createRequire(import.meta.resolve('@vue/compiler-sfc'))
const { baseParse, NodeTypes } = require('@vue/compiler-dom')
const han = /\p{Script=Han}/u
const root = fileURLToPath(new URL('../../', import.meta.url))
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const messages = readJson('src/shared/i18n/en-US.json')
const chinese = readJson('src/shared/i18n/zh-CN.json')
const prompts = readJson('src/main/ai/prompts/i18n/en-US.json')
const chinesePrompts = readJson('src/main/ai/prompts/i18n/zh-CN.json')
const exceptions = readJson('scripts/i18n/exceptions.json')
const translationCalls = new Map([
  ['t', [0, messages]],
  ['appText', [0, messages]],
  ['translate', [1, messages]],
  ['aiText', [0, prompts]],
  ['promptText', [1, prompts]]
])

export function checkDictionaries(english, chinese, label, named = false) {
  const problems = []
  const placeholders = (value) =>
    [...value.matchAll(named ? /\{([A-Za-z][A-Za-z0-9_]*)\}/g : /\{(\d+)\}/g)]
      .map((match) => match[1])
      .sort()
  for (const key of new Set([...Object.keys(english), ...Object.keys(chinese)])) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+$/.test(key)) {
      problems.push(`${label}: invalid translation key ${JSON.stringify(key)}`)
    }
    const en = english[key]
    const zh = chinese[key]
    if (typeof en !== 'string' || !en.trim() || typeof zh !== 'string' || !zh.trim()) {
      problems.push(`${label}: missing EN/CN translation for ${key}`)
      continue
    }
    if (han.test(en)) problems.push(`${label}: Chinese text in English translation ${key}`)
    if (JSON.stringify(placeholders(en)) !== JSON.stringify(placeholders(zh))) {
      problems.push(`${label}: mismatched placeholders for ${key}`)
    }
  }
  return problems
}

export function checkSource(code, file, tests = false) {
  const problems = []
  const permitted = new Set((exceptions.literals[file] ?? []).map((entry) => entry.text))
  const embedded = exceptions.embeddedPrograms.includes(file)
  const report = (text, kind = 'unlocalized text') => {
    if (han.test(text) && !permitted.has(text)) {
      problems.push(`${file}: ${kind} ${JSON.stringify(text)}`)
    }
  }
  function script(code, nested = false) {
    const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
    function walk(node) {
      if (ts.isCallExpression(node)) {
        const call = translationCalls.get(node.expression.getText(source))
        if (call) {
          const [index, dictionary] = call
          const key = node.arguments[index]
          if (key && ts.isStringLiteralLike(key)) {
            if (han.test(key.text) || !Object.hasOwn(dictionary, key.text)) {
              problems.push(
                `${file}: invalid or missing translation key ${JSON.stringify(key.text)}`
              )
            }
          }
          // Inspect interpolation arguments too; wrapping text in t() must not hide Chinese.
          for (let i = 0; i < node.arguments.length; i++) {
            if (i !== index) walk(node.arguments[i])
          }
          return
        }
      }
      if (!tests && ts.isStringLiteralLike(node)) {
        if (embedded && !nested && han.test(node.text)) program(node.text)
        else report(node.text)
      }
      if (!tests && ts.isTemplateExpression(node)) {
        const template =
          node.head.text + node.templateSpans.map((span) => span.literal.text).join('')
        if (embedded && !nested && han.test(template)) program(template)
        else report(template)
        for (const span of node.templateSpans) walk(span.expression)
        return
      }
      if (!tests && node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        report(node.getText(source), 'unapproved Chinese recognition pattern')
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
  }
  // Embedded JS/CSS/HTML comments have the same exemption as comments in source files.
  function program(code) {
    if (/<(?:script|style)\b/i.test(code)) {
      const markup = code.replace(
        /<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi,
        (_, tag, content) => {
          if (tag.toLowerCase() === 'script') script(content, true)
          else report(content.replace(/\/\*[\s\S]*?\*\//g, ''))
          return ''
        }
      )
      report(markup.replace(/<!--[\s\S]*?-->/g, ''))
    } else script(code, true)
  }
  if (!file.endsWith('.vue')) {
    script(code)
    return problems
  }
  const { descriptor } = parse(code)
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (block) script(block.content)
  }
  if (descriptor.template) {
    function walk(node) {
      if (node.type === NodeTypes.TEXT) report(node.content.trim())
      if (node.type === NodeTypes.INTERPOLATION) script(node.content.content)
      for (const prop of node.props ?? []) {
        if (prop.type === NodeTypes.ATTRIBUTE && prop.value) report(prop.value.content)
        else if (prop.exp) script(prop.exp.content)
      }
      for (const child of node.children ?? []) walk(child)
    }
    walk(baseParse(descriptor.template.content))
  }
  return problems
}

function checkDirectory(dir, problems) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const file = path.posix.join(dir, entry.name)
    if (entry.isDirectory()) {
      // Benchmark designs intentionally contain Chinese content to exercise Unicode editing.
      if (file !== 'src/main/ai/fixtures/rbac-benchmark') checkDirectory(file, problems)
    } else if (/\.(vue|[cm]?[jt]sx?)$/.test(file) && !/\.d\.ts$/.test(file)) {
      problems.push(
        ...checkSource(
          fs.readFileSync(path.join(root, file), 'utf8'),
          file,
          /\.(test|bench)\.ts$/.test(file)
        )
      )
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = [
    ...checkDictionaries(messages, chinese, 'Application'),
    ...checkDictionaries(prompts, chinesePrompts, 'Prompts', true)
  ]
  checkDirectory('src', problems)
  checkDirectory('scripts', problems)
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else {
    console.log(
      `Localization check passed (${Object.keys(messages).length} application keys, ${Object.keys(prompts).length} prompt keys; EN/CN).`
    )
  }
}
