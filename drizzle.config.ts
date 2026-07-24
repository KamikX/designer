import { defineConfig } from 'drizzle-kit'

/**
 * 只用来生成迁移 SQL（`pnpm db:generate`），不做运行时迁移。
 *
 * drizzle 自带的 migrate() 要在运行时读 migrationsFolder 这个目录，
 * 打包进 Electron 后 dev/prod 路径不一致、还得处理 asar，很容易翻车。
 * 我们改成把生成的 .sql 用 ?raw 编进 main 的 bundle，由
 * src/main/db/migrations.ts 里的 user_version runner 执行——
 * 没有任何文件系统依赖，迁移内容和代码版本天然绑死。
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/main/db/schema.ts',
  out: './src/main/db/migrations'
})
