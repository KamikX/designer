import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'

const require = createRequire(import.meta.resolve('@vue/compiler-sfc'))
const { baseParse, NodeTypes } = require('@vue/compiler-dom')
const messages = JSON.parse(fs.readFileSync('src/shared/i18n/en-US.json', 'utf8'))
const han = /\p{Script=Han}/u
// Language self-name, a protocol-reserved member name, and a translated field key.
const allowed = new Map([
  ['src/renderer/src/components/config/config.ts', new Set(['简体中文'])],
  ['src/renderer/src/pages/collab/member-drafts.ts', new Set(['用户'])],
  ['src/renderer/src/pages/home/components/create-project.ts', new Set(['视觉风格（可选）'])]
])
const problems = []
function checkText(text, file) {
  if (han.test(text) && !allowed.get(file)?.has(text)) {
    problems.push(`${file}: unlocalized text ${JSON.stringify(text)}`)
  }
}
function checkScript(code, file) {
  const source = ts.createSourceFile('component.ts', code, ts.ScriptTarget.Latest, true)
  function walk(node) {
    if (ts.isCallExpression(node) && /^console\./.test(node.expression.getText(source))) return
    if (ts.isCallExpression(node) && node.expression.getText(source) === 't') {
      const key = node.arguments[0]
      if (key && ts.isStringLiteralLike(key) && !Object.hasOwn(messages, key.text)) {
        problems.push(`${file}: missing English translation ${JSON.stringify(key.text)}`)
      }
      // Other arguments are user data or values, not translation keys.
      return
    }
    if (ts.isStringLiteralLike(node)) checkText(node.text, file)
    if (ts.isTemplateExpression(node)) {
      checkText(node.head.text + node.templateSpans.map((part) => part.literal.text).join(''), file)
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
}
function checkFile(file) {
  const text = fs.readFileSync(file, 'utf8')
  if (!file.endsWith('.vue')) return checkScript(text, file)
  const { descriptor } = parse(text)
  for (const block of [descriptor.script, descriptor.scriptSetup]) {
    if (block) checkScript(block.content, file)
  }
  if (!descriptor.template) return
  function walk(node) {
    if (node.type === NodeTypes.TEXT) checkText(node.content.trim(), file)
    if (node.type === NodeTypes.INTERPOLATION) checkScript(node.content.content, file)
    for (const prop of node.props ?? []) {
      if (prop.type === NodeTypes.ATTRIBUTE && prop.value) checkText(prop.value.content, file)
      else if (prop.exp) checkScript(prop.exp.content, file)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(baseParse(descriptor.template.content))
}
function checkDirectory(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) checkDirectory(file)
    else if (/\.(vue|ts)$/.test(file) && !/\.(test|d)\.ts$/.test(file)) checkFile(file)
  }
}
checkDirectory('src/renderer/src')
if (problems.length) {
  console.error(problems.join('\n'))
  process.exitCode = 1
} else {
  console.log(
    `UI localization check passed (${Object.keys(messages).length} English translations).`
  )
}
