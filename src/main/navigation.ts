export type AppNavigationKind = 'internal' | 'external' | 'blocked'

export interface AppNavigationResolution {
  kind: AppNavigationKind
  url: string | null
}

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])

function parseUrl(value: string, base?: URL): URL | null {
  try {
    return base ? new URL(value, base) : new URL(value)
  } catch {
    return null
  }
}

function isInternalNavigation(target: URL, current: URL | null): boolean {
  if (!current) return false

  if (
    (current.protocol === 'http:' || current.protocol === 'https:') &&
    target.protocol === current.protocol
  ) {
    return target.origin === current.origin
  }

  if (current.protocol !== 'file:' || target.protocol !== 'file:') return false
  const rendererDirectory = new URL('.', current).href
  return target.href.startsWith(rendererDirectory)
}

export function resolveAppNavigation(
  targetUrl: string,
  currentAppUrl: string
): AppNavigationResolution {
  const current = parseUrl(currentAppUrl)
  const target = parseUrl(targetUrl, current ?? undefined)
  if (!target) return { kind: 'blocked', url: null }
  if (isInternalNavigation(target, current)) return { kind: 'internal', url: target.href }
  if (EXTERNAL_PROTOCOLS.has(target.protocol)) return { kind: 'external', url: target.href }
  return { kind: 'blocked', url: null }
}

export function classifyAppNavigation(targetUrl: string, currentAppUrl: string): AppNavigationKind {
  return resolveAppNavigation(targetUrl, currentAppUrl).kind
}
