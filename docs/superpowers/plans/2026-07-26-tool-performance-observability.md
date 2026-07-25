# AI Tool Performance, Reliable Editing, and Usage Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add seven-day AI run diagnostics, durable per-model token accounting, MagicString-based anchored editing, and programmatic context/tool budgets so Designer runs are faster, explainable, and recover safely from patch failures.

**Architecture:** Introduce a local-only observability repository and a `RunTraceCollector` around every language-model entry point, with step usage aggregated transactionally into a long-lived daily table. Keep file edits in `SessionVfs`, but add revision-bound anchors and an atomic `MagicStringBatchEditor`; a per-run ledger then supplies sanitised traces, failure recovery, history compaction, target routing, and hard execution budgets through AI SDK `prepareStep` and tool wrappers.

**Tech Stack:** TypeScript, Electron IPC/preload, Vue 3 + Pinia + Ant Design Vue, AI SDK 7, Drizzle ORM + SQLite, MagicString, Vitest

---

## Scope and file responsibility map

This is one integrated plan because tracing, usage, tool lifecycle, editing recovery, and context governance share the same run/step/call identifiers. Implement in the order below so every later optimisation can be measured by the earlier telemetry.

**New main-process modules**

- `src/main/ai/usage.ts`: normalise AI SDK usage without inventing unreported fields; extract allowlisted provider totals.
- `src/main/ai/run-trace.ts`: own run/step/tool lifecycle and invoke the persistence repository.
- `src/main/ai/tool-trace-sanitizer.ts`: per-tool metadata allowlists and secondary redaction.
- `src/main/ai/anchor-registry.ts`: revision-bound non-empty UTF-16 ranges.
- `src/main/ai/string-edits.ts`: validate and atomically compute MagicString edits.
- `src/main/ai/tool-result.ts`: structured tool errors and recovery metadata.
- `src/main/ai/run-context-ledger.ts`: revisions, anchors, failures, fingerprints, counters, and cumulative budget state.
- `src/main/ai/compact-tool-history.ts`: schema-valid call/result compaction plus the idempotent `<tool_ledger>`.
- `src/main/ai/context-governor.ts`: `prepareStep`, token estimation, routing, and budget decisions.
- `src/main/db/repo/ai-observability.ts`: diagnostic writes, transactional daily aggregation, queries, retention, and clearing.

**New renderer modules**

- `src/renderer/src/pages/usage/index.vue`: independent model-usage page and filters.
- `src/renderer/src/stores/usage.ts`: usage query state.
- `src/renderer/src/pages/project/components/RunDiagnostics.vue`: seven-day per-message run details.

**Existing integration points**

- `src/main/db/schema.ts`, the generated `src/main/db/migrations/0013_*.sql` and migration metadata: five local-only tables.
- `src/shared/types.ts`, `src/main/ipc/index.ts`, `src/preload/index.ts`: detailed usage, diagnostics, query contracts, and lifecycle events.
- `src/main/ai/chat-service.ts`, `src/main/ai/group-service.ts`, `src/main/ai/assistant.ts`, `src/main/ai/registry.ts`: traced model entry points. Do not add a `document_summary` call unless repository inspection finds an actual language-model invocation.
- `src/main/ai/session-vfs.ts`, `src/main/ai/tools.ts`, `src/main/ai/tool-activity.ts`: revisions, anchors, structured results, and accurate preparing/executing phases.
- `src/main/ai/prompts/index.ts`, `src/main/ai/prompts/targets.ts`: active-target routing and tool recovery instructions.
- `src/renderer/src/stores/chat.ts`, `src/renderer/src/stores/collab.ts`, `src/renderer/src/pages/project/components/ToolActivityList.vue`, `src/renderer/src/pages/project/components/MessageItem.vue`, `src/renderer/src/pages/collab/components/GroupMessage.vue`: lifecycle display and diagnostics entry.
- `src/renderer/src/router/index.ts`, `src/renderer/src/layouts/default/menu.ts`: independent usage page.

### Task 1: Detailed usage contracts and normalisation

**Files:**
- Create: `src/main/ai/usage.ts`
- Create: `src/main/ai/usage.test.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Write failing tests for reported, zero, partial, and absent token fields**

Cover `inputTokens`, `inputTokenDetails.noCacheTokens/cacheReadTokens/cacheWriteTokens`,
`outputTokens`, `outputTokenDetails.textTokens/reasoningTokens`, `totalTokens`, and field-specific
`reported` flags. Add provider raw cases for a recognised OpenAI-compatible
`raw.usage.total_tokens` shape and an unknown shape.

```ts
expect(normalizeStepUsage({
  inputTokens: 100,
  inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40 },
  outputTokens: 20,
  outputTokenDetails: { textTokens: 12, reasoningTokens: 8 },
  totalTokens: 120
})).toMatchObject({
  inputTokens: 100,
  cacheReadTokens: 40,
  cacheWriteTokens: null,
  reported: { cacheReadTokens: true, cacheWriteTokens: false }
})
```

- [ ] **Step 2: Run the focused test and verify the new module is missing**

Run: `pnpm vitest run src/main/ai/usage.test.ts`

Expected: FAIL because `./usage` cannot be resolved.

- [ ] **Step 3: Add shared types and the pure normaliser**

Extend `ChatUsage` with optional detailed fields while retaining required
`inputTokens`/`outputTokens`. Define `DetailedUsage`, `UsageReportedFields`, `UsageScene`, and
`UsageEstimate`. Keep unreported optional metrics as `null`; never coerce them to zero. Implement
an explicit provider-extractor registry keyed by provider adapter/slug, returning only numeric
allowlisted totals and never retaining `usage.raw`.

- [ ] **Step 4: Run usage and shared-type tests**

Run: `pnpm vitest run src/main/ai/usage.test.ts src/main/db/repo/message.test.ts`

Expected: PASS, including the distinction between unreported and reported zero.

- [ ] **Step 5: Commit the usage contract**

```bash
git add src/shared/types.ts src/main/ai/usage.ts src/main/ai/usage.test.ts
git commit -m "feat: define detailed model usage"
```

### Task 2: SQLite diagnostics, aggregation, and seven-day retention

**Files:**
- Modify: `src/main/db/schema.ts`
- Create: `src/main/db/repo/ai-observability.ts`
- Create: `src/main/db/repo/ai-observability.test.ts`
- Create: `src/main/db/migrations/0013_*.sql` via `pnpm db:generate`
- Modify: `src/main/db/migrations/meta/_journal.json` via `pnpm db:generate`
- Create: `src/main/db/migrations/meta/0013_snapshot.json` via `pnpm db:generate`
- Modify: `src/main/db/migrate-safety.test.ts`

- [ ] **Step 1: Write repository tests against a temporary SQLite database**

Test the five tables from the spec: `ai_runs`, `ai_run_steps`, `tool_runs`,
`model_usage_daily`, and `model_usage_run_days`. Required cases:

- same run/day/dimension with multiple steps increments `run_count` once;
- the same run crossing UTC midnight increments each date once;
- a model request inserts a pending step at call start and preserves an error/aborted step even when
  AI SDK never emits `onStepEnd`;
- provider/model/project/scene keys do not duplicate when project is absent;
- unreported fields do not increment `reported_calls`;
- step insert, daily upsert, run-day insert, and run summary update roll back together;
- seven-day cleanup deletes only diagnostics and run-day bridge rows;
- clearing usage deletes daily and bridge rows in one transaction;
- deleting a project cascade-deletes linked `ai_runs`, `ai_run_steps`, and `tool_runs`;
- deleted provider/project snapshots remain queryable without foreign keys.

- [ ] **Step 2: Run repository tests and verify schema/repository failures**

Run: `pnpm vitest run src/main/db/repo/ai-observability.test.ts`

Expected: FAIL because observability tables and repository functions do not exist.

- [ ] **Step 3: Add schema and repository transactions**

Use non-null `providerKey` and `projectKey` in unique keys:

```ts
const projectKey = projectId ? `project:${projectId}` : 'none'
const insertedRunDay = insertRunDayIgnore(tx, {
  runId, utcDate, providerKey, modelId, scene, projectKey
})
upsertDaily(tx, usage, { runIncrement: insertedRunDay ? 1 : 0 })
```

Expose narrowly scoped methods: `startRun`, `startModelStep`, `finishModelStep`,
`markInterruptedRuns`, `startTool`, `updateToolPhase`, `finishTool`, `finishRun`,
`getRunDiagnostics`, `queryDailyUsage`, `cleanupDiagnostics`, and `clearUsage`.
`startModelStep` inserts the actual request before dispatch; `finishModelStep` updates timing/status
and performs the daily usage/run summary transaction when usage exists. Make the finish operation
idempotent by `run_id + call_id`, so `onLanguageModelCallEnd` and `onStepEnd` cannot double count.
Use an explicit `pending → ended_without_usage → aggregated` state: an early model-call-end may
finalise timing/status without closing the row to enrichment, and a later `onStepEnd` may atomically
attach usage exactly once. Repeated end callbacks after `aggregated` are no-ops.
Diagnostic tables use project-linked cascade semantics; long-lived aggregates and the run-day
bridge use snapshots/normalised keys without business foreign keys. Do not add any of the five
tables to `SYNCED_TABLES` or change-log triggers.

- [ ] **Step 4: Generate and inspect the migration**

Run: `pnpm db:generate`

Expected: one new `0013_*.sql`, one snapshot, and one journal entry. Inspect the SQL to confirm
there are no prompt/body columns, no business-table foreign keys on long-lived aggregates, and
the compound uniqueness rules match the spec.

- [ ] **Step 5: Run repository and migration-safety tests**

Run: `pnpm vitest run src/main/db/repo/ai-observability.test.ts src/main/db/migrate-safety.test.ts`

Expected: PASS and all historical migrations remain immutable.

- [ ] **Step 6: Commit the persistence layer**

```bash
git add src/main/db/schema.ts src/main/db/repo/ai-observability.ts \
  src/main/db/repo/ai-observability.test.ts src/main/db/migrate-safety.test.ts \
  src/main/db/migrations
git commit -m "feat: persist AI diagnostics and usage"
```

### Task 3: Privacy-safe tool tracing and run lifecycle

**Files:**
- Create: `src/main/ai/tool-trace-sanitizer.ts`
- Create: `src/main/ai/tool-trace-sanitizer.test.ts`
- Create: `src/main/ai/run-trace.ts`
- Create: `src/main/ai/run-trace.test.ts`
- Modify: `src/main/db/index.ts`

- [ ] **Step 1: Write failing sanitizer tests for every tool family**

Use secret-bearing inputs to assert that:

- VFS tools retain only validated design-relative paths, counts, and character sizes;
- local workspace paths retain hash + extension, never absolute path, relative path, or basename;
- URL tools retain host only and searches retain query length only;
- `activate_skill` may retain skill name;
- `ask_user` retains only question/option counts;
- MCP retains server/tool and sizes, no values;
- unknown tools retain no target;
- provider/unknown errors become mapped codes or the fixed fallback;
- final strings redact path, URL, email, and credential patterns and cap summaries at 240 chars.

- [ ] **Step 2: Run the sanitizer test and verify failure**

Run: `pnpm vitest run src/main/ai/tool-trace-sanitizer.test.ts`

Expected: FAIL because the sanitizer registry does not exist.

- [ ] **Step 3: Implement the allowlist registry and secondary redactor**

Require explicit registrations; the default sanitizer must return only tool name, input/output
character counts, duration, and fixed error code. Reuse VFS path validation rather than accepting
an arbitrary string that merely looks relative.

- [ ] **Step 4: Write failing lifecycle tests**

Use a fake repository and fake clock to verify:

```text
startRun → modelCallStart → firstOutput → toolInputStart → toolCall
→ toolExecutionStart → firstFilePatch → toolExecutionEnd → stepEnd → finishRun
```

Also test recovered errors, fatal errors, aborts, startup interruption, and a missing-message
`provider_test` run. A request must call `startModelStep` before provider dispatch; if it throws or
aborts without `onStepEnd`, the same row must be finalised as error/aborted with null unreported
usage rather than disappearing.

- [ ] **Step 5: Implement `RunTraceCollector` and startup maintenance**

`RunTraceCollector` owns monotonic timestamps in memory and persists ISO timestamps/durations.
Model-call start inserts the pending step; model-call end/error/abort and `onStepEnd` converge on
the idempotent finish path from Task 2. Successful `onStepEnd` supplies detailed usage to the same
transaction; failed calls retain the step with null unreported usage. At database startup, mark
stale `running` rows `interrupted`, then execute idempotent retention cleanup without blocking
renderer startup on cleanup completion.

- [ ] **Step 6: Run tracing tests**

Run: `pnpm vitest run src/main/ai/tool-trace-sanitizer.test.ts src/main/ai/run-trace.test.ts`

Expected: PASS; fixture database searches find none of the supplied secrets or bodies.

- [ ] **Step 7: Commit tracing**

```bash
git add src/main/ai/tool-trace-sanitizer.ts src/main/ai/tool-trace-sanitizer.test.ts \
  src/main/ai/run-trace.ts src/main/ai/run-trace.test.ts src/main/db/index.ts
git commit -m "feat: trace AI run and tool lifecycle"
```

### Task 4: Instrument every real language-model entry point

**Files:**
- Modify: `src/main/ai/chat-service.ts`
- Modify: `src/main/ai/group-service.ts`
- Modify: `src/main/ai/assistant.ts`
- Modify: `src/main/ai/registry.ts`
- Modify: `src/main/ai/chat-service.test.ts` if present, otherwise create it
- Modify: `src/main/ai/group-chain.test.ts`
- Modify: `src/main/ai/assistant.test.ts`
- Create: `src/main/ai/model-entrypoints.test.ts`

- [ ] **Step 1: Enumerate actual model calls and write a coverage test**

Search with:

```bash
rg -n "streamText\\(|generateText\\(|streamObject\\(|generateObject\\(" src/main
```

Expected current production call sites: chat, group, assistant, and provider test. Assert each
creates a trace with `design|chat|group|assistant|provider_test` as appropriate. Inspect
`summarize.ts`; only instrument `document_summary` if it actually invokes a language model.

- [ ] **Step 2: Run the entry-point test and verify missing traces**

Run: `pnpm vitest run src/main/ai/model-entrypoints.test.ts`

Expected: FAIL because model calls do not create run/step rows.

- [ ] **Step 3: Wire AI SDK lifecycle callbacks without changing generation behaviour**

Create the trace before each call, pass AI SDK model-call/tool-execution lifecycle callbacks, feed
every `onStepEnd` to the collector, and finish the run in `finally`. Preserve any existing callbacks
by composing them. Count provider connection tests as durable usage even though they have no
message/project.

- [ ] **Step 4: Verify multi-step partial usage and terminal states**

Run: `pnpm vitest run src/main/ai/model-entrypoints.test.ts src/main/ai/assistant.test.ts src/main/ai/group-chain.test.ts src/main/ai/full-stream-error.test.ts`

Expected: PASS; a later-step failure still leaves earlier steps in daily usage, and abort/error are
distinct.

- [ ] **Step 5: Commit model instrumentation**

```bash
git add src/main/ai/chat-service.ts src/main/ai/group-service.ts \
  src/main/ai/assistant.ts src/main/ai/registry.ts src/main/ai/model-entrypoints.test.ts \
  src/main/ai/chat-service.test.ts src/main/ai/group-chain.test.ts src/main/ai/assistant.test.ts
git commit -m "feat: instrument model entry points"
```

If an optional test file was not changed or created, omit it from `git add`; never use `git add -A`.

### Task 5: IPC, lifecycle UI, diagnostics, and model-usage page

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/stores/chat.ts`
- Modify: `src/renderer/src/stores/collab.ts`
- Create: `src/renderer/src/stores/usage.ts`
- Create: `src/renderer/src/stores/usage.test.ts`
- Modify: `src/renderer/src/pages/project/components/ToolActivityList.vue`
- Modify: `src/renderer/src/pages/project/components/MessageItem.vue`
- Modify: `src/renderer/src/pages/collab/components/GroupMessage.vue`
- Create: `src/renderer/src/pages/project/components/RunDiagnostics.vue`
- Create: `src/renderer/src/pages/usage/index.vue`
- Modify: `src/renderer/src/router/index.ts`
- Modify: `src/renderer/src/layouts/default/menu.ts`

- [ ] **Step 1: Write failing store tests for phase transitions and filters**

Verify `tool-input-start` maps to `preparing`, `onToolExecutionStart` maps to `executing`, and terminal
states are `success|recoverable_error|fatal_error|aborted`. Test usage query parameters for date,
provider, model, project, and scene, plus `null` display for unreported cache/reasoning fields.

- [ ] **Step 2: Run renderer store tests and verify failure**

Run: `pnpm vitest run src/renderer/src/stores/usage.test.ts src/renderer/src/stores/chat.test.ts`

Expected: FAIL because the usage store and expanded lifecycle do not exist. If `chat.test.ts` does
not exist, create it in this step and include the focused lifecycle cases.

- [ ] **Step 3: Add narrow IPC/preload contracts**

Expose:

```ts
observability: {
  runForMessage(messageId: string): Promise<RunDiagnostics | null>
  usage(query: UsageQuery): Promise<UsageReport>
  clearUsage(): Promise<void>
}
```

Do not expose SQL or mutation of trace rows. Fetch seven-day details lazily when the user opens the
diagnostic drawer.

- [ ] **Step 4: Implement truthful phase labels**

Change tool activity labels to “准备补丁/准备编辑” until execution starts, then “执行补丁/执行编辑”.
Only show a local-performance warning when execution exceeds 500ms. Yellow recoverable entries
remain visible after success with their recovery count; fatal errors remain red.

- [ ] **Step 5: Implement diagnostics and independent usage page**

`RunDiagnostics.vue` shows total and first-output/first-file timing, step count, tool timeline,
slowest step, recoveries, and detailed tokens. `/usage` shows day/provider/model/project/scene
filters, cache hit ratio, average tokens per run, and per step; render “未报告”, not `0`, for missing
metrics. Add a normal navigation entry without changing Settings panels.

- [ ] **Step 6: Run store tests and typecheck**

Run: `pnpm vitest run src/renderer/src/stores/usage.test.ts src/renderer/src/stores/chat.test.ts && pnpm typecheck`

Expected: PASS with no renderer/main contract mismatch.

- [ ] **Step 7: Commit observability UI**

```bash
git add src/shared/types.ts src/main/ipc/index.ts src/preload/index.ts \
  src/renderer/src/stores/chat.ts src/renderer/src/stores/collab.ts \
  src/renderer/src/stores/usage.ts src/renderer/src/stores/usage.test.ts \
  src/renderer/src/pages/project/components/ToolActivityList.vue \
  src/renderer/src/pages/project/components/MessageItem.vue \
  src/renderer/src/pages/project/components/RunDiagnostics.vue \
  src/renderer/src/pages/collab/components/GroupMessage.vue \
  src/renderer/src/pages/usage/index.vue src/renderer/src/router/index.ts \
  src/renderer/src/layouts/default/menu.ts
git commit -m "feat: show AI diagnostics and model usage"
```

### Task 6: Revisioned VFS and UTF-16 anchor registry

**Files:**
- Modify: `src/main/ai/session-vfs.ts`
- Modify: `src/main/ai/session-vfs.test.ts`
- Create: `src/main/ai/anchor-registry.ts`
- Create: `src/main/ai/anchor-registry.test.ts`

- [ ] **Step 1: Write failing VFS revision tests**

Assert initial revision, increment-on-success, no increment for identical/no-op or rejected writes,
atomic multi-file commit, and a single Monaco/file-patch event only after all files commit.

- [ ] **Step 2: Write failing anchor coordinate tests**

Cover 1-based inclusive line/column input, half-open internal offsets, omitted columns, optional
trailing newline, LF/CRLF, Chinese text, emoji, rejection at a surrogate-pair midpoint, empty
ranges, out-of-bounds coordinates, and stale revision/hash.

- [ ] **Step 3: Run the focused tests**

Run: `pnpm vitest run src/main/ai/session-vfs.test.ts src/main/ai/anchor-registry.test.ts`

Expected: FAIL because VFS entries have no revision and anchors do not exist.

- [ ] **Step 4: Refactor VFS entries and implement anchors**

Store `{ content, revision }` internally while keeping compatibility helpers for callers that need
plain strings. Anchor records contain only `id`, validated path, revision, start/end offsets, and
content hash. All anchors are non-empty. Add invalidation helpers for committed file revisions.

- [ ] **Step 5: Run VFS and anchor tests**

Run: `pnpm vitest run src/main/ai/session-vfs.test.ts src/main/ai/anchor-registry.test.ts`

Expected: PASS for UTF-16 and transaction/event semantics.

- [ ] **Step 6: Commit revisions and anchors**

```bash
git add src/main/ai/session-vfs.ts src/main/ai/session-vfs.test.ts \
  src/main/ai/anchor-registry.ts src/main/ai/anchor-registry.test.ts
git commit -m "feat: add revision-bound edit anchors"
```

### Task 7: Atomic MagicString batch editor

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/main/ai/string-edits.ts`
- Create: `src/main/ai/string-edits.test.ts`

- [ ] **Step 1: Add MagicString as a direct dependency**

Run: `pnpm add magic-string`

Expected: `package.json` and `pnpm-lock.yaml` list a direct runtime dependency, independent of any
transitive lockfile entry.

- [ ] **Step 2: Write failing editor tests**

Test replace/remove/insert-before/insert-after, multiple before/after order, one
before+replace/remove+after composite, adjacent anchors, partially/fully overlapping anchors,
original-coordinate stability, multi-file success, multi-file rollback, stale/hash mismatch,
800–1700-character lines, emoji, and CRLF/LF.

```ts
// Per anchor, emit one update only:
magic.update(anchor.startOffset, anchor.endOffset, before + core + after)
```

- [ ] **Step 3: Run the editor test and verify failure**

Run: `pnpm vitest run src/main/ai/string-edits.test.ts`

Expected: FAIL because `MagicStringBatchEditor` does not exist.

- [ ] **Step 4: Implement normalisation, conflict checks, compute, then commit**

Group operations by anchor, reject more than one replace/remove per anchor, sort non-empty ranges
by original offsets, permit adjacency, and reject any actual overlap before calling MagicString.
Compute every output string first; only then call the VFS atomic commit and emit events. Do not use
`prependLeft`/`appendRight`, persistent MagicString instances, regex replacement, movement, or
sourcemaps.

- [ ] **Step 5: Run editor and VFS tests**

Run: `pnpm vitest run src/main/ai/string-edits.test.ts src/main/ai/session-vfs.test.ts`

Expected: PASS; failed batches leave content, revisions, and events unchanged.

- [ ] **Step 6: Commit MagicString editing**

```bash
git add package.json pnpm-lock.yaml src/main/ai/string-edits.ts src/main/ai/string-edits.test.ts
git commit -m "feat: add atomic MagicString edits"
```

### Task 8: Anchored tools, structured errors, and recovery rules

**Files:**
- Create: `src/main/ai/tool-result.ts`
- Create: `src/main/ai/tool-result.test.ts`
- Create: `src/main/ai/run-context-ledger.ts`
- Create: `src/main/ai/run-context-ledger.test.ts`
- Modify: `src/main/ai/tools.ts`
- Modify: `src/main/ai/tools.test.ts`
- Modify: `src/main/ai/tool-activity.ts`
- Modify: `src/main/ai/tool-activity.test.ts`
- Modify: `src/main/ai/prompts/protocol.ts`

- [ ] **Step 1: Write failing tool contract tests**

Required behaviours:

- `search_files` returns `matchId` for each full internal match while preview truncation is labelled
  non-authoritative;
- `capture_range` returns exact untruncated text and `anchorId`;
- `apply_string_edits` accepts the four operation types and commits atomically;
- old `edit_file`, `multi_edit_file`, and `apply_patch` remain callable;
- all file tools return `ToolResult`;
- errors include the spec codes and safe recovery hints;
- first patch mismatch recommends anchored editing;
- the same patch error twice on one file disables text patch for that file;
- three consecutive write failures require relocation/read;
- identical tool/target/parameter fingerprints cannot execute twice.

- [ ] **Step 2: Run tool tests and verify failure**

Run: `pnpm vitest run src/main/ai/tool-result.test.ts src/main/ai/run-context-ledger.test.ts src/main/ai/tools.test.ts`

Expected: FAIL for missing anchored tools and structured recovery.

- [ ] **Step 3: Implement result helpers and the per-run ledger**

Define the exact `ToolErrorCode` union from the spec plus `TOOL_BUDGET_EXCEEDED`. Fingerprints must
hash canonicalised safe inputs in memory only; never persist full arguments. Classify upstream
429/5xx/timeouts separately from local recoverable/fatal failures.

- [ ] **Step 4: Add `capture_range`, match IDs, and `apply_string_edits`**

Construct schemas beside the current file tools. Keep the tool collection stable during a run.
Register anchors in the run ledger and invalidate stale anchors after VFS commits. Send Monaco
patch events only after successful atomic commit.

- [ ] **Step 5: Update tool labels and prompt recovery contract**

Add human labels for the two new tools and teach the protocol to switch on truncated/long lines or
the first patch mismatch. Add an editability warning for single lines over 800 characters and
recommend multiline arrays/columns/options without blocking saves.

- [ ] **Step 6: Run all file-tool tests**

Run: `pnpm vitest run src/main/ai/tool-result.test.ts src/main/ai/run-context-ledger.test.ts src/main/ai/tools.test.ts src/main/ai/tool-activity.test.ts src/main/ai/session-vfs.test.ts src/main/ai/string-edits.test.ts`

Expected: PASS, including recovery and backwards compatibility.

- [ ] **Step 7: Commit reliable tools**

```bash
git add src/main/ai/tool-result.ts src/main/ai/tool-result.test.ts \
  src/main/ai/run-context-ledger.ts src/main/ai/run-context-ledger.test.ts \
  src/main/ai/tools.ts src/main/ai/tools.test.ts src/main/ai/tool-activity.ts \
  src/main/ai/tool-activity.test.ts src/main/ai/prompts/protocol.ts
git commit -m "feat: add anchored editing recovery"
```

### Task 9: Schema-valid tool-history compaction

**Files:**
- Create: `src/main/ai/compact-tool-history.ts`
- Create: `src/main/ai/compact-tool-history.test.ts`
- Create: `src/main/ai/compact-tool-history.integration.test.ts`

- [ ] **Step 1: Write failing pure-function tests**

Construct AI SDK model messages containing text/reasoning plus parallel tool calls and tool results.
Verify compaction:

- replaces completed successful and failed large write arguments/results by call ID;
- removes stale read/search/capture results only after revision change;
- retains the newest content required by live anchors;
- retains the first activated skill body once, then replaces repeated `activate_skill` call/result
  pairs with a short “already active” fact derived from `activatedSkills`;
- retains unrelated parallel calls/results and ordinary text/reasoning;
- removes empty assistant/tool messages;
- keeps calls/results paired;
- emits exactly one replaceable user-role `<tool_ledger>` marked as runtime facts;
- updates that ledger idempotently;
- validates with `modelMessageSchema`.

- [ ] **Step 2: Run the pure tests and verify failure**

Run: `pnpm vitest run src/main/ai/compact-tool-history.test.ts`

Expected: FAIL because the compactor is missing.

- [ ] **Step 3: Implement call-ID selection and ledger replacement**

Treat the input as immutable. Filter individual parts rather than whole mixed messages. Build
short summaries from `RunContextLedger` only—path/revision/result/error/recovery—and never place
full patch, file content, or raw tool arguments in the ledger. Use `activatedSkills` to keep the
first successful skill body available and compact only later duplicate activations to the short
ledger fact; do not remove the sole body needed for the run.

- [ ] **Step 4: Add a fake multi-step model integration test**

The fake model should reject invalid message schemas and inspect its second request. Assert a large
completed patch and stale read are absent, while successful write facts and the next live anchor
remain sufficient to continue.

- [ ] **Step 5: Run compaction tests**

Run: `pnpm vitest run src/main/ai/compact-tool-history.test.ts src/main/ai/compact-tool-history.integration.test.ts`

Expected: PASS and the second-step serialised request is materially smaller.

- [ ] **Step 6: Commit context compaction**

```bash
git add src/main/ai/compact-tool-history.ts src/main/ai/compact-tool-history.test.ts \
  src/main/ai/compact-tool-history.integration.test.ts
git commit -m "feat: compact completed tool history"
```

### Task 10: Context governor, active-target routing, and hard tool budgets

**Files:**
- Create: `src/main/ai/context-governor.ts`
- Create: `src/main/ai/context-governor.test.ts`
- Modify: `src/main/ai/chat-service.ts`
- Modify: `src/main/ai/group-service.ts`
- Modify: `src/main/ai/prompts/index.ts`
- Modify: `src/main/ai/prompts/targets.ts`
- Modify: `src/main/ai/prompts/targets.test.ts`
- Modify: `src/main/ai/tools.ts`
- Modify: `src/main/ai/tools.test.ts`

- [ ] **Step 1: Write failing target-routing tests**

Assert explicit current-turn target wins, then unique manifest/path, then single project target,
otherwise only short compatibility contracts. An admin-only RBAC turn must include the full admin
template and exclude full landing/web templates.

- [ ] **Step 2: Write failing governor and synchronous gate tests**

Cover:

- 20 calls triggers compaction/merge guidance;
- 30 calls forbids rereading an unchanged file;
- 40 calls stops subsequent steps;
- a single parallel step with two remaining slots permits exactly two tool executes, whether they
  are reads or writes;
- excess read-only and side-effectful calls both return `TOOL_BUDGET_EXCEEDED` without invoking
  their underlying execute function;
- 3× context window forces compaction and 5× ends after preserving complete writes;
- reported input usage wins;
- missing usage estimates `ceil(serializedChars / 2)`, marks diagnostics estimated, and does not
  enter reported durable usage;
- stable tool schemas are maintained until a capability is truly unavailable or a fatal lock
  applies.

- [ ] **Step 3: Run routing/governor tests and verify failure**

Run: `pnpm vitest run src/main/ai/context-governor.test.ts src/main/ai/prompts/targets.test.ts src/main/ai/tools.test.ts`

Expected: FAIL because `prepareStep` governance and reservation are absent.

- [ ] **Step 4: Implement `ContextGovernor.prepareStep`**

Use `compactToolHistory`, target routing, ledger restrictions, and the final serialised
instructions/messages/tool schemas to make each decision. Keep estimates separate from
`DetailedUsage.reported`. Return an explicit terminal note when a hard budget ends the run.

- [ ] **Step 5: Wrap every tool execute with one synchronous `ToolBudgetGate`**

`reserve(callId)` must mutate its in-memory reservation count before the execute promise starts, so
parallel read or write calls cannot race beyond 40. Calls that fail reservation return
`TOOL_BUDGET_EXCEEDED` without invoking their underlying execute function. Once a fatal
VFS/SQLite/artifact consistency error occurs, lock all subsequent writes and set a
`forbidArtifactFinalization` flag in the run ledger.

- [ ] **Step 6: Integrate `prepareStep` in design/chat and group loops**

Replace the chat hardcoded 100-call cap with shared 20/30/40 policies; keep group behaviour aligned.
Compose with tracing from Task 4, and ensure step usage updates the same run ledger immediately.
Before the existing chat/artifact completion path creates an artifact, require
`ledger.canFinalizeArtifact()`; a fatal consistency error must finish the run as fatal and leave no
new artifact. Add a service-level test that commits one valid edit, injects a fatal consistency
failure, and verifies neither the partial/final VFS state nor markers are published as a new
artifact.

- [ ] **Step 7: Run context, prompt, and service tests**

Run: `pnpm vitest run src/main/ai/context-governor.test.ts src/main/ai/compact-tool-history.integration.test.ts src/main/ai/prompts/targets.test.ts src/main/ai/tools.test.ts src/main/ai/group-chain.test.ts src/main/ai/model-entrypoints.test.ts`

Expected: PASS; only reserved calls produce VFS events and the next model request is schema-valid.
Fatal consistency fixtures must also prove the artifact repository is never called.

- [ ] **Step 8: Commit governance**

```bash
git add src/main/ai/context-governor.ts src/main/ai/context-governor.test.ts \
  src/main/ai/chat-service.ts src/main/ai/group-service.ts src/main/ai/prompts/index.ts \
  src/main/ai/prompts/targets.ts src/main/ai/prompts/targets.test.ts \
  src/main/ai/tools.ts src/main/ai/tools.test.ts
git commit -m "feat: govern AI context and tool budgets"
```

### Task 11: Synthetic RBAC benchmark, privacy audit, and release verification

**Files:**
- Create: `src/main/ai/fixtures/rbac-benchmark/` with seven synthetic Vue/CSS fixture files
- Create: `src/main/ai/tool-performance.bench.test.ts`
- Create: `src/main/ai/observability-privacy.test.ts`
- Create: `docs/tool-performance-benchmark.md`
- Modify: `docs/superpowers/specs/2026-07-26-tool-performance-observability-design.md` only if implementation evidence requires an explicitly documented deviation

- [ ] **Step 1: Add the fixed synthetic fixture and baseline assertions**

The fixture must be about 25KB, contain seven files, modify five, and include deterministic
800–1700-character lines. It must contain no copied user project data. Record exact fixture byte
and line-size checks so future formatting cannot silently remove the stress case.

- [ ] **Step 2: Add local editor and orchestration benchmark tests**

Measure atomic five-file edit duration across enough warm iterations to calculate p95; assert p95
under 100ms on the project test environment. Separately run a deterministic fake-model scenario and
assert no truncation-driven `MATCH_NOT_FOUND`, no repeated identical failure, no more than 20 normal
tool calls, hard enforcement at 40, and fewer than 5 failed edit attempts per 100 attempted edit
operations.

- [ ] **Step 3: Add a database privacy audit**

Execute representative design, local workspace, browser/web, ask-user, MCP, provider failure, and
unknown-tool traces containing canary secrets. Query every text column in the five observability
tables and assert no prompt, reasoning, file body, patch body, search term, absolute/basename path,
answer, URL path/query, email, or credential survives.

- [ ] **Step 4: Run the focused acceptance suite**

Run:

```bash
pnpm vitest run \
  src/main/ai/tool-performance.bench.test.ts \
  src/main/ai/observability-privacy.test.ts \
  src/main/db/repo/ai-observability.test.ts \
  src/main/ai/string-edits.test.ts \
  src/main/ai/compact-tool-history.integration.test.ts \
  src/main/ai/context-governor.test.ts
```

Expected: PASS, including p95, privacy, retention, atomicity, schema validity, and budget assertions.

- [ ] **Step 5: Document measured before/after data**

In `docs/tool-performance-benchmark.md`, record fixture revision, machine/runtime, iterations,
local edit p50/p95, first-file time from the deterministic harness, step/tool counts, detailed
tokens, cache reported/unreported state, and retry count. Clearly separate deterministic local
measurements from provider-network observations; do not claim a 15-second provider result without
a real end-to-end sample.

- [ ] **Step 6: Run complete verification**

Run:

```bash
pnpm vitest run
pnpm typecheck
pnpm lint
git diff --check
```

Expected: all tests pass, typecheck/lint exit 0, and no whitespace errors. If unrelated pre-existing
workspace changes fail a command, rerun the narrow affected suite and document the exact unrelated
failure rather than modifying those files.

- [ ] **Step 7: Inspect generated/changed data boundaries**

Run:

```bash
rg -n "ai_runs|ai_run_steps|tool_runs|model_usage_daily|model_usage_run_days" src/main/db/index.ts src/main/db/schema.ts
rg -n "prompt|reasoning|patch|content|raw" src/main/db/schema.ts src/main/db/repo/ai-observability.ts
git status --short
```

Expected: observability tables are absent from sync registration; any `reasoning` match is a numeric
token field only; no raw prompt/file/patch storage; unrelated user files are not staged.

- [ ] **Step 8: Commit benchmark and verification artifacts**

```bash
git add src/main/ai/fixtures/rbac-benchmark \
  src/main/ai/tool-performance.bench.test.ts \
  src/main/ai/observability-privacy.test.ts \
  docs/tool-performance-benchmark.md
git commit -m "test: verify AI tool performance governance"
```

### Task 12: Final review and handoff

**Files:**
- Review all files committed in Tasks 1–11

- [ ] **Step 1: Use the required verification skill**

Invoke `@superpowers:verification-before-completion` and rerun the commands it requires. Do not
claim completion from earlier output.

- [ ] **Step 2: Request a code review**

Invoke `@superpowers:requesting-code-review` with the accepted spec, this plan, the implementation
commit range, and explicit attention to privacy, transactionality, AI SDK message schemas,
MagicString coordinate semantics, and parallel budget reservations.

- [ ] **Step 3: Address blocking findings with focused tests**

For each accepted finding, first add or adjust a failing regression test, then implement the
smallest fix and rerun the focused suite. Keep each logically separate fix in its own commit.

- [ ] **Step 4: Re-run final verification and update benchmark evidence**

Run:

```bash
pnpm vitest run
pnpm typecheck
pnpm lint
git diff --check
```

Expected: all commands pass after review fixes and the benchmark document matches final code.

- [ ] **Step 5: Finish the development branch**

Invoke `@superpowers:finishing-a-development-branch` and offer the user its supported merge/PR
options. Do not stage, discard, or commit unrelated dirty-worktree changes.
