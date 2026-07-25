import { realpathSync, statSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/index'
import { workspaceRoots } from '../db/schema'
import type { WorkspaceRoot } from '../../shared/types'
import { MAX_FILES_AT_ONCE } from '../../shared/limits'

/**
 * 本地目录授权。
 *
 * 这是整个本地文件能力的**唯一权限来源**,也是唯一的安全边界。设计原则
 * 只有一条:**AI 永远不能自己扩大可见范围**。
 *
 * - 授权只能由用户在界面上主动选目录产生,没有任何工具能新增 root
 * - 每次解析路径都要 realpath 之后再判断归属——不然 `projects/link`
 *   指向 `/` 的软链就能一路读出去
 * - 没有任何 root 时,本地文件工具**整组不注册**;模型看不到工具,也就
 *   没有可以试探的入口
 */

/**
 * 授权范围的归属。恰好有一个字段非空:
 *
 * - 设计项目 → `{ projectId }`,授权跟着项目走
 * - 纯聊天   → `{ conversationId }`,授权跟着这次会话走,会话删了就回收
 *
 * 用一个联合类型而不是两个可选参数:后者允许"两个都传"和"都不传"这两种
 * 无意义的调用,而且要到运行时才发现。
 */
export type RootScope = { projectId: string } | { conversationId: string }

function whereScope(scope: RootScope): ReturnType<typeof eq> {
  return 'projectId' in scope
    ? eq(workspaceRoots.projectId, scope.projectId)
    : eq(workspaceRoots.conversationId, scope.conversationId)
}

function toView(row: {
  id: string
  projectId: string | null
  conversationId: string | null
  path: string
  name: string
}): WorkspaceRoot {
  return {
    id: row.id,
    ...(row.projectId ? { projectId: row.projectId } : {}),
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    path: row.path,
    name: row.name
  }
}

export function listRoots(scope: RootScope): WorkspaceRoot[] {
  return getDb().select().from(workspaceRoots).where(whereScope(scope)).all().map(toView)
}

/**
 * 授权一个目录或**单个文件**。
 *
 * 允许文件是有意的:用户在对话里丢一个 `~/需求.pdf` 时,只该让 AI 看到
 * 这个文件,而不是把它所在的整个目录(可能是家目录)一并交出去。
 * contains() 里 `parent === child` 那条正好覆盖单文件的情形。
 */
export function addRoot(scope: RootScope, rawPath: string, name?: string): WorkspaceRoot {
  const path = realpathSync(resolve(rawPath))
  statSync(path) // 不存在就抛,不要写一条读不了的授权进库

  const existing = listRoots(scope).find((r) => r.path === path)
  if (existing) return existing

  const row = getDb()
    .insert(workspaceRoots)
    .values({ ...scope, path, name: name ?? path.split(sep).pop() ?? path })
    .returning()
    .get()
  return toView(row)
}

export function removeRoot(id: string): void {
  getDb().delete(workspaceRoots).where(eq(workspaceRoots.id, id)).run()
}

/**
 * 批量授权。
 *
 * 单条失败不影响其余——一次拖十个文件,不该因为其中一个是坏的符号链接
 * 就整批拒掉。失败的原样返回,由界面告诉用户是哪几个、为什么。
 */
export function grantPaths(scope: RootScope, paths: string[]): GrantOutcome {
  const granted: GrantedRoot[] = []
  const rejected: { path: string; reason: string }[] = []

  for (const raw of paths.slice(0, MAX_FILES_AT_ONCE)) {
    try {
      const root = addRoot(scope, raw)
      granted.push({ ...root, isFile: statSync(root.path).isFile() })
    } catch (err) {
      rejected.push({ path: raw, reason: reasonOf(err) })
    }
  }
  return { granted, rejected }
}

export interface GrantedRoot extends WorkspaceRoot {
  /** 文件还是目录。只用于界面显示,不入库 */
  isFile: boolean
}

export interface GrantOutcome {
  granted: GrantedRoot[]
  rejected: { path: string; reason: string }[]
}

function reasonOf(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT') return '文件不存在'
  if (code === 'EACCES' || code === 'EPERM') return '没有读取权限'
  if (code === 'ELOOP') return '符号链接成环'
  return err instanceof Error ? err.message : String(err)
}

/**
 * 把模型给的路径解析成真实绝对路径,并确认它落在某个已授权的 root 里。
 *
 * 接受两种写法:绝对路径,或相对于某个 root 的路径(`根名/子路径`)。
 * 解析失败与越界一律抛错——**宁可拒绝一次合法请求,也不能放过一次越界**。
 */
export function resolveWithin(roots: WorkspaceRoot[], input: string): string {
  if (roots.length === 0) throw new Error('本项目还没有授权任何本地目录。')

  const trimmed = input.trim()
  if (!trimmed) throw new Error('路径不能为空。')

  const candidates: string[] = []
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    candidates.push(resolve(trimmed))
  } else {
    // 相对写法:先按"根名开头"试,再按"每个 root 下的相对路径"试
    const [head, ...rest] = trimmed.split(/[\\/]/)
    for (const root of roots) {
      if (root.name === head) candidates.push(resolve(root.path, rest.join(sep)))
      candidates.push(resolve(root.path, trimmed))
    }
  }

  for (const candidate of candidates) {
    // realpath 之后再判归属:软链指向外部时,拼接结果看着还在根里
    let real: string
    try {
      real = realpathSync(candidate)
    } catch {
      continue
    }
    if (roots.some((root) => contains(root.path, real))) return real
  }

  throw new Error(
    `路径不在授权范围内,或不存在:${trimmed}。当前可访问:${roots.map((r) => r.name).join('、')}`
  )
}

/**
 * child 是否在 parent 之内(或就是 parent)。
 *
 * 三个条件缺一不可:非空(排除自身,已单独处理)、不以 .. 开头(排除往上爬)、
 * 不是绝对路径(Windows 上跨盘符时 relative 会返回绝对路径)。
 */
export function contains(parent: string, child: string): boolean {
  if (parent === child) return true
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** 展示用:把绝对路径缩成 `根名/相对路径` */
export function displayPath(roots: WorkspaceRoot[], absolute: string): string {
  for (const root of roots) {
    if (!contains(root.path, absolute)) continue
    const rel = relative(root.path, absolute)
    return rel ? `${root.name}${sep}${rel}` : root.name
  }
  return absolute
}
