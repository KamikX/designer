import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { decryptSecret, encryptSecret } from '../crypto'
import { DATA_DIR, ensureDataDirs } from '../paths'
import type { KeyStorage } from '../crypto'

/**
 * MCP 服务用到的密钥。
 *
 * ## 为什么不放在 mcp.json 里
 *
 * 那个文件是给人看和手改的——用户会拷贝它、贴进 issue、同步到网盘。密钥一旦
 * 写进去就会跟着跑。所以 mcp.json 里只留 `${GITHUB_TOKEN}` 这样的占位符,
 * 真值在这里加密存着,**启动进程前才展开**。
 *
 * ## 为什么不走数据库
 *
 * 数据库参与多设备同步(见 db/index.ts 的 SYNCED_TABLES)。密钥不该跟着同步——
 * 另一台机器上的密钥应该由那台机器自己配。文件在同步范围之外,天然满足这点。
 */

const FILE = join(DATA_DIR, 'secrets.json')

interface Stored {
  [key: string]: { cipher: string; storage: KeyStorage }
}

function load(): Stored {
  if (!existsSync(FILE)) return {}
  try {
    return JSON.parse(readFileSync(FILE, 'utf-8')) as Stored
  } catch {
    // 坏了就当空的。**不要抛**——一个坏掉的密钥文件不该让整个应用起不来
    return {}
  }
}

export function setSecret(key: string, value: string): void {
  ensureDataDirs()
  const all = load()
  all[key] = encryptSecret(value)
  writeFileSync(FILE, `${JSON.stringify(all, null, 2)}\n`, 'utf-8')
}

export function setSecrets(values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value) setSecret(key, value)
  }
}

/** 全部解密出来,给启动进程时展开 ${VAR} 用 */
export function allSecrets(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(load())) {
    const plain = decryptSecret(entry.cipher, entry.storage)
    if (plain !== null) out[key] = plain
  }
  return out
}

/** 只回名字,不回值。界面上显示"已配置哪些"用 */
export function secretNames(): string[] {
  return Object.keys(load())
}

export function hasSecret(key: string): boolean {
  return key in load()
}
