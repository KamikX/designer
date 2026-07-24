/**
 * 迁移脚本清单。
 *
 * SQL 由 `pnpm db:generate`（drizzle-kit）根据 schema.ts 生成，
 * 这里用 ?raw 编进 main 的 bundle——不走运行时文件系统，
 * 打包后没有 asar / 路径问题，迁移内容和代码版本天然绑死。
 *
 * 文件名前缀就是顺序（0000_、0001_…），按名字排序即执行顺序。
 * 规则：**已发布的迁移永远不要改**，用户库里跑过的不会重跑，
 * 改了只会让新老机器的表结构对不上。
 */
const modules = import.meta.glob<string>('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true
})

export const MIGRATIONS: string[] = Object.keys(modules)
  .sort()
  .map((path) => modules[path])
