import { readFileSync, writeFileSync } from 'fs'
import type { AppConfig } from '../shared/types'
import { DEFAULT_TOOL_CALL_LIMIT } from '../shared/limits'
import { CONFIG_FILE, ensureDataDirs } from './paths'

/**
 * 轻量应用配置。
 *
 * 这里只放小而扁的键值：主题、语言、窗口尺寸。会增长、要查询的结构化数据
 * 走 SQLite，不要往这个文件里塞。
 *
 * 之所以从 renderer 的 localStorage 挪到主进程：main 读不到 localStorage，
 * 窗口创建时就不知道该用亮色还是暗色，毛玻璃和底色只能等渲染进程起来后再
 * 纠正，启动瞬间会闪一下。放在这里 main 能同步读，创建窗口前就定好。
 */

export type { AppConfig, Lang } from '../shared/types'

const DEFAULT_CONFIG: AppConfig = {
  lang: 'zh-CN',
  dark: false,
  primaryColor: '#1677ff',
  window: { width: 1400, height: 900 },
  assistantModel: null,
  searchApi: null,
  marketUrl: '',
  toolCallLimit: DEFAULT_TOOL_CALL_LIMIT,
  // 最保守的组合:不依赖服务端持久化,也不用任何非标准选项
  openaiCompat: { store: false, encryptedReasoning: false }
}

let cache: AppConfig | null = null

function write(config: AppConfig): void {
  ensureDataDirs()
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
}

export function readConfig(): AppConfig {
  if (cache) return cache

  ensureDataDirs()
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Partial<AppConfig>
    // 浅合并即可：配置只有一层嵌套，且新增字段要能用上默认值
    cache = {
      ...DEFAULT_CONFIG,
      ...raw,
      window: { ...DEFAULT_CONFIG.window, ...raw.window },
      openaiCompat: { ...DEFAULT_CONFIG.openaiCompat, ...raw.openaiCompat }
    }
  } catch (e) {
    // 配置有问题绝不能挡住启动，一律退回默认值
    cache = { ...DEFAULT_CONFIG }

    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      // 首次启动：把默认值写出来。这个目录的意义就是让用户能直接
      // 翻看和手改，文件不存在的话无从改起
      write(cache)
    } else {
      // 内容损坏：只在内存里用默认值，不覆盖用户的文件——
      // 里面可能有他手改坏的内容，留着让他自己修
      console.error(`[config] ${CONFIG_FILE} 解析失败，本次使用默认配置：`, e)
    }
  }
  return cache
}

export function patchConfig(patch: Partial<AppConfig>): AppConfig {
  const next = { ...readConfig(), ...patch }
  cache = next
  write(next)
  return next
}
