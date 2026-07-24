import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

/**
 * 应用数据目录。
 *
 * 用 ~/.antd-designer 而不是 app.getPath('userData')，是为了让用户能直接
 * 翻看 / 备份 / 同步这个目录——设计器的配置和项目文件本来就该是可见的。
 * 代价是 Windows 上点开头的目录不符合平台习惯、卸载器也不会清理它。
 *
 * 想换位置只改这一处，或者用环境变量覆盖（也方便跑测试时隔离数据）。
 */
export const DATA_DIR = process.env.ANTD_DESIGNER_HOME ?? join(homedir(), '.antd-designer')

export const CONFIG_FILE = join(DATA_DIR, 'config.json')
export const DB_FILE = join(DATA_DIR, 'designer.db')
export const PROJECTS_DIR = join(DATA_DIR, 'projects')
export const LOGS_DIR = join(DATA_DIR, 'logs')

/** 在任何读写之前调一次。recursive 模式下目录已存在也不报错 */
export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, PROJECTS_DIR, LOGS_DIR]) {
    mkdirSync(dir, { recursive: true })
  }
}
