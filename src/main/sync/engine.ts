import { dataBackendView } from '../services-config'

/**
 * 同步引擎入口 —— 本期占位。
 *
 * 对外只有这一个函数:mode='local' 直接返回,整个 sync 模块可整体
 * 删除而主链路无感。二期在这里实现:
 * 1. 先交付"备份/恢复"(全量 push / 全量 pull,复用同一套 sync_rows);
 * 2. 再交付增量双向同步:写后 debounce push + 定时/手动 pull,
 *    小批次 + setImmediate 让出事件循环,pull 应用期间置
 *    local_meta.sync_applying='1' 防触发器回环;
 * 3. 驱动依赖 mysql2 / postgres(porsager),放 dependencies 并动态
 *    import,绝不引 pg-native。
 */
export function startSyncEngine(): void {
  const { mode } = dataBackendView()
  if (mode === 'local') return
  // 二期:按 mode 创建 self-hosted / cloud 后端并启动调度
}
