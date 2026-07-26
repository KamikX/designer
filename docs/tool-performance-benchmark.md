# AI 工具性能基准(RBAC 固定场景)

对应设计文档:`docs/superpowers/specs/2026-07-26-tool-performance-observability-design.md`。

## Fixture

- 位置:`src/main/ai/fixtures/rbac-benchmark/`(7 个合成 Vue/CSS 文件,**不含任何用户项目数据**)
- 精确字节数:**24,103 bytes**(钉死在 `tool-performance.bench.test.ts` 的断言里)
- 超长行(UTF-16 字符数,全部落在 800–1700 压力区):

  | 文件 | 行内容 | 长度 |
  | --- | --- | --- |
  | RoleForm.vue | 超长 rules 定义 | 854 |
  | RoleList.vue | 超长 columns 数组 | 1068 |
  | UserTable.vue | 超长 options 级联 | 1390 |
  | admin.css | 压缩单行 CSS | 1670 |

改动 fixture 必须同步更新断言常量并重录本文件。

## 测量环境

- 机器:Apple Mac mini(Darwin 25.4.0,arm64)
- 运行时:Node.js v24,vitest 4.1,better-sqlite3 内存库
- 日期:2026-07-25
- 命令:`pnpm vitest run src/main/ai/tool-performance.bench.test.ts --disable-console-intercept`

## 本地确定性测量(不含任何网络)

### 五文件原子编辑(MagicStringBatchEditor)

30 次热身迭代,每次:5 个文件各取一个锚点(含 1670 字符压缩行)→ 一次
`apply_string_edits` 原子提交。

| 指标 | 实测 | 验收线 |
| --- | --- | --- |
| p50 | 0.05 ms | — |
| p95 | **0.09 ms** | < 100 ms ✅ |

结论:本地补丁引擎从来不是慢的那一环——"应用补丁很慢"的观感来自模型
生成参数时间被错记到本地执行头上(现已由 preparing/executing 相位拆开)。

### 确定性假模型编排(5 文件修改)

脚本化三步:并行 capture_range × 5 → apply_string_edits(5 操作原子提交)→ 收尾解说。

| 指标 | 实测 | 验收线 |
| --- | --- | --- |
| 工具调用总数 | **6** | 目标 ≤ 20,硬上限 40 ✅ |
| 截断复述导致的 MATCH_NOT_FOUND | **0** | 0 ✅ |
| 同一错误连续出现 | **0** | 不得连续两次 ✅ |
| 编辑失败率 | **0 / 5** | < 5% ✅ |
| 步内累计上报输入(假模型) | 3,500 tokens | 硬上限 5× 窗口 ✅ |
| 40 上限并行超发 | 同步闸门拒绝 1/2,被拒调用零副作用 | 硬执行 ✅ |

首个文件变化时间:确定性 harness 下由 `first_file_change_at` 记录(见
`ai_runs`),本地执行部分 < 1 ms;端到端"15 秒内首个文件变化"取决于
provider 网络与模型首包,**本文件不声称任何 provider 网络结论**——尚未
采集真实端到端样本,待真实使用后由 `/usage` 页与运行诊断给出。

### 缓存与 token 观测口径

- 详细 token(输入/非缓存/缓存读/缓存写/输出/思考)按 step 落
  `ai_run_steps`,provider 未报告的字段保持 `NULL` 且不进 `reported_calls`;
  假模型场景中缓存字段全部为**未报告**,展示层显示"未报告"而不是 0。
- 重试计数:确定性场景失败 0 次、重试 0 次;真实场景由 `tool_runs` 的
  `recoverable_error` 行与 `recovered` 标记还原。

## 改造前后对照(结构性,非同机复测)

改造前的问题基线来自设计文档中对"Antdv Next测试"项目 SQLite 的只读分析:

| 维度 | 改造前 | 改造后机制 |
| --- | --- | --- |
| 单轮累计输入 | 45 万–68 万 token | 完成写/过期读按 callId 压缩 + 3×/5× 窗口熔断 |
| 超长行编辑 | 截断复述 → MATCH_NOT_FOUND | capture_range/matchId + apply_string_edits,0 失配 |
| 工具调用上限 | 100 次(只防跑飞) | 20 软 / 30 禁重读 / 40 硬,同步名额闸门 |
| 阶段观感 | 参数生成误记为本地执行 | preparing/executing 相位 + 500ms 本地性能警告 |
| 事后还原 | 无持久数据 | 7 天诊断三表 + 长期日聚合 |

## 复跑方式

```bash
pnpm vitest run src/main/ai/tool-performance.bench.test.ts --disable-console-intercept
pnpm vitest run src/main/ai/observability-privacy.test.ts
```
