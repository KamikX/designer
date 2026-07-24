import { ipcMain, nativeTheme } from 'electron'
import type { AppConfig } from '../config'
import { patchConfig, readConfig } from '../config'
import { createProject, deleteProject, listProjects, renameProject } from '../db/repo/project'

/**
 * 统一注册 IPC。
 *
 * 约定：需要返回值的一律用 handle/invoke，通道名带命名空间。
 * 只暴露领域方法，不暴露原始 SQL 和文件路径。
 */
export function registerIpc(): void {
  // preload 在加载时同步取一次初始配置，渲染进程首帧就能拿到正确的
  // 主题和语言，不用等异步 IPC 回来再纠正一次
  ipcMain.on('config:read-sync', (e) => {
    e.returnValue = readConfig()
  })

  ipcMain.handle('config:read', () => readConfig())

  ipcMain.handle('config:patch', (_e, patch: Partial<AppConfig>) => {
    const next = patchConfig(patch)
    // 毛玻璃的明暗跟随系统外观，不跟应用内开关，得同步过去
    nativeTheme.themeSource = next.dark ? 'dark' : 'light'
    return next
  })

  ipcMain.handle('project:list', () => listProjects())
  ipcMain.handle('project:create', (_e, name: string) => createProject(name))
  ipcMain.handle('project:rename', (_e, id: number, name: string) => renameProject(id, name))
  ipcMain.handle('project:delete', (_e, id: number) => deleteProject(id))
}
