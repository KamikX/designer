import { mkdirSync, writeFileSync } from 'fs'
import { basename, dirname, join, normalize, sep } from 'path'
import AdmZip from 'adm-zip'
import { dialog } from 'electron'
import type { Skill } from '../shared/types'
import { createSkill } from './db/repo/skill'
import { DATA_DIR } from './paths'

/**
 * 技能压缩包导入。
 *
 * 包格式约定(与 Claude 技能包一致):zip 内必须有 SKILL.md,
 * 可带 YAML frontmatter(name/description),正文即技能内容;
 * 其余文件(参考资料、模板)解压到 DATA_DIR/skills/<id>/ 留给
 * 运行时引用。没有 SKILL.md 直接拒绝。
 */
export async function importSkillPackage(givenPath?: string): Promise<Skill | null> {
  let zipPath = givenPath
  if (!zipPath) {
    const res = await dialog.showOpenDialog({
      title: '选择技能压缩包',
      filters: [{ name: '技能包', extensions: ['zip'] }],
      properties: ['openFile']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    zipPath = res.filePaths[0]
  }

  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries().filter((e) => !e.isDirectory)

  // 找 SKILL.md:允许在根目录或单层目录里(常见的"整个文件夹打包"习惯),
  // 多个时取层级最浅的
  const skillEntry = entries
    .filter((e) => /(^|\/)SKILL\.md$/i.test(e.entryName))
    .sort((a, b) => a.entryName.split('/').length - b.entryName.split('/').length)[0]
  if (!skillEntry) {
    throw new Error('压缩包必须包含 SKILL.md 文件')
  }

  const raw = skillEntry.getData().toString('utf-8')
  const { name, description, body } = parseSkillMd(raw)

  const skill = createSkill({
    name: name || basename(zipPath, '.zip'),
    description,
    content: body
  })

  // 整包解压留档(逐条校验路径,防 zip-slip 目录穿越)
  const targetDir = join(DATA_DIR, 'skills', skill.id)
  const packageRoot = dirname(skillEntry.entryName) === '.' ? '' : dirname(skillEntry.entryName)
  for (const entry of entries) {
    // 以 SKILL.md 所在目录为包根,去掉外层文件夹前缀
    const relative = packageRoot ? entry.entryName.replace(`${packageRoot}/`, '') : entry.entryName
    const target = normalize(join(targetDir, relative))
    if (target !== targetDir && !target.startsWith(targetDir + sep)) continue
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.getData())
  }

  return skill
}

/** 解析 SKILL.md:可选的 YAML frontmatter(只认 name/description 两行)+ 正文 */
function parseSkillMd(raw: string): { name: string; description: string; body: string } {
  const text = raw.replace(/^﻿/, '')
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { name: '', description: '', body: text.trim() }
  }
  const front = match[1]
  const pick = (key: string): string =>
    front
      .match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'mi'))?.[1]
      .trim()
      .replace(/^['"]|['"]$/g, '') ?? ''
  return { name: pick('name'), description: pick('description'), body: match[2].trim() }
}
