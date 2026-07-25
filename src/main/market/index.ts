import { builtinCatalog } from './builtin'
import type { CatalogSource } from './types'

/**
 * 市场数据源的出口。
 *
 * 现在恒定返回内置清单。以后要接远端时,在这里按配置选实现即可——上层
 * (IPC、页面)不用改。
 */
export function catalog(): CatalogSource {
  return builtinCatalog
}

export type { CatalogSource, EnvHint, MarketMcp, MarketSkill } from './types'
