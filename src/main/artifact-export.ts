import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join, normalize, sep } from 'path'
import { dialog, shell } from 'electron'
import { getArtifact, getArtifactFiles } from './db/repo/artifact'
import { getProject } from './db/repo/project'

/**
 * 导出设计稿:弹目录选择框,把当前版本的整棵文件树写出去。
 * 返回导出目录;用户取消返回 null。
 */
export async function exportArtifact(artifactId: string): Promise<string | null> {
  const artifact = getArtifact(artifactId)
  if (!artifact) throw new Error('设计稿版本不存在')
  const project = getProject(artifact.projectId)

  const result = await dialog.showOpenDialog({
    title: '选择导出目录',
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null

  // 目录名带项目名和版本号,避免直接把一堆文件倒进用户选的目录
  const dirName = `${sanitizeName(project?.name ?? 'design')}-v${artifact.version}`
  const targetDir = join(result.filePaths[0], dirName)

  for (const file of getArtifactFiles(artifactId)) {
    const safe = safeJoin(targetDir, file.path)
    mkdirSync(dirname(safe), { recursive: true })
    writeFileSync(safe, file.content, 'utf-8')
  }

  shell.showItemInFolder(targetDir)
  return targetDir
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 50) || 'design'
}

/**
 * 防目录穿越:AI 生成的路径不可信,拼接后必须仍在目标目录内。
 * 系统 prompt 禁止了 .. 和绝对路径,这里是最后一道闸。
 */
function safeJoin(base: string, relative: string): string {
  const target = normalize(join(base, relative))
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`非法文件路径:${relative}`)
  }
  return target
}
