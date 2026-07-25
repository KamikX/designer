import type { McpTransport } from '../../shared/types'

/**
 * 市场的数据源契约。
 *
 * 现在只有一个内置实现(清单写死在代码里,跟着版本发)。抽出这个接口是为了
 * 以后能换成远端拉取而不用动上层——但**没有为此提前做任何远端相关的设计**:
 * 托管在哪、谁审核、离线怎么办,这些等真要做时再回答,现在猜只会猜错。
 */
export interface CatalogSource {
  skills(): Promise<MarketSkill[]>
  mcp(): Promise<MarketMcp[]>
}

export interface MarketSkill {
  id: string
  name: string
  description: string
  tags: string[]
  /** 技能正文,安装时原样写进本地技能表 */
  content: string
}

/** MCP 服务需要用户自己补的环境变量(API key 之类) */
export interface EnvHint {
  key: string
  label: string
  /** 去哪儿申请 */
  help?: string
}

export interface MarketMcp {
  id: string
  name: string
  description: string
  tags: string[]
  transport: McpTransport
  /** stdio 类:安装确认框里要**原样展示**给用户看的命令 */
  command?: string
  args?: string[]
  /** sse / http 类 */
  url?: string
  envHints?: EnvHint[]
  /** 包主页,让用户能自己去核实这是什么东西 */
  homepage?: string
}
