import { text as appText } from './i18n'
import { translate } from '../shared/i18n'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { basename, dirname, join, normalize, sep } from 'path'
import AdmZip from 'adm-zip'
import { dialog } from 'electron'
import type { InstalledSkill } from '../shared/types'
import { DATA_DIR } from './paths'

/**
 * 技能压缩包导入,解压到「我的技能」目录(~/.antd-designer/skills/<名字>)。
 *
 * 包格式约定(与 Claude 技能包一致):zip 内必须有 SKILL.md,可带 YAML
 * frontmatter(name/description),其余文件(references/assets)原样落地,
 * 渐进披露的第三层就靠它们。没有 SKILL.md 直接拒绝。
 *
 * 落地后技能的身份是**目录名**(frontmatter 的 name,缺了用 zip 文件名),
 * 与扫描器的规则一致。同名已存在就报错——静默覆盖会吃掉用户自己改过的版本。
 */
export async function importSkillPackage(givenPath?: string): Promise<InstalledSkill | null> {
  let zipPath = givenPath
  if (!zipPath) {
    const res = await dialog.showOpenDialog({
      title: translate(
        (await import('./config')).readConfig().lang,
        'messages.selectASkillArchive'
      ),
      filters: [
        {
          name: translate((await import('./config')).readConfig().lang, 'common.skillArchive'),
          extensions: ['zip']
        }
      ],
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
    throw new Error(appText('messages.theArchiveMustContainASkillMdFile'))
  }

  const raw = skillEntry.getData().toString('utf-8')
  const { name, description } = parseSkillMd(raw)
  const dirName = sanitizeDirName(name || basename(zipPath, '.zip'))

  const targetDir = join(DATA_DIR, 'skills', dirName)
  if (existsSync(targetDir)) {
    throw new Error(appText('messages.skillAlreadyExistsDeleteItBeforeImporting', dirName))
  }

  // 整包解压(逐条校验路径,防 zip-slip 目录穿越)
  const packageRoot = dirname(skillEntry.entryName) === '.' ? '' : dirname(skillEntry.entryName)
  for (const entry of entries) {
    // 以 SKILL.md 所在目录为包根,去掉外层文件夹前缀
    const relative = packageRoot ? entry.entryName.replace(`${packageRoot}/`, '') : entry.entryName
    const target = normalize(join(targetDir, relative))
    if (target !== targetDir && !target.startsWith(targetDir + sep)) continue
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.getData())
  }

  return { name: dirName, description, source: 'app', dir: targetDir }
}

/** 目录名不能带路径分隔符;frontmatter 的 name 是不可信输入 */
function sanitizeDirName(name: string): string {
  const cleaned = name.replace(/[/\\]/g, '-').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('.')) {
    throw new Error(appText('messages.invalidSkillName', name))
  }
  return cleaned
}

/** 解析 SKILL.md:可选的 YAML frontmatter(只认 name/description 两行)+ 正文 */
function parseSkillMd(raw: string): { name: string; description: string } {
  const text = raw.replace(/^\uFEFF/, '')
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { name: '', description: '' }
  const front = match[1]
  const pick = (key: string): string =>
    front
      .match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'mi'))?.[1]
      .trim()
      .replace(/^['"]|['"]$/g, '') ?? ''
  return { name: pick('name'), description: pick('description') }
}
