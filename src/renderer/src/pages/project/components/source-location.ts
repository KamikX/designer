export interface SourceLocation {
  path: string
  line: number
  column: number
}

export interface SourceNavigation extends SourceLocation {
  projectId: string
  artifactId: string
  endLine?: number
  endColumn?: number
}

export function parseSourceLocation(source: unknown): SourceLocation | null {
  if (typeof source !== 'string') return null
  const match = /^(.+):(\d+):(\d+)$/.exec(source)
  if (!match) return null
  const line = Number(match[2])
  const column = Number(match[3])
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(column) || column < 1) {
    return null
  }
  return { path: match[1], line, column }
}
