import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join, normalize, sep } from 'path'
import { ASSETS_DIR } from '../../paths'
import type { StorageBackend } from '../types'

/** 本地目录后端:零配置默认。key 即 assets 目录下的相对路径。 */
export function createLocalBackend(): StorageBackend {
  const resolve = (key: string): string => {
    const target = normalize(join(ASSETS_DIR, key))
    if (!target.startsWith(ASSETS_DIR + sep)) throw new Error(`非法资源 key: ${key}`)
    return target
  }
  return {
    async put(key, data) {
      const file = resolve(key)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, data)
    },
    async get(key) {
      return readFileSync(resolve(key))
    },
    async delete(key) {
      rmSync(resolve(key), { force: true })
    },
    publicUrl() {
      return null
    },
    async test() {
      // 本地目录没有可失败的配置项
    }
  }
}
