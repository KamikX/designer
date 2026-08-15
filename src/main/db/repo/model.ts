import { asc, eq, sql } from 'drizzle-orm'
import type {
  CreateModelInput,
  Model,
  ModelAbility,
  ModelSelection,
  ModelType
} from '../../../shared/types'
import { inferContextWindow, inferModelMeta } from '../../../shared/model-caps'

/** 老的一刀切窗口默认值。等于它的行视为"从未确认过",可按家族推断升级 */
const LEGACY_DEFAULT_WINDOW = 64000
import { getDb } from '../index'
import { models } from '../schema'
import type { ModelRow } from '../schema'

/**
 * 模型仓储。
 *
 * 库里 type 单值列 + capabilities JSON 列(存 abilities,列名历史原因)。
 * 出入库转换收口在这一层;老数据的 capabilities 里可能残留
 * 'chat'/'image' 等旧枚举,读取时过滤掉。
 */

const LEGACY_VALUES = new Set(['chat', 'image'])

function toView(row: ModelRow): Model {
  let abilities: ModelAbility[] = []
  try {
    abilities = (JSON.parse(row.capabilities) as string[]).filter(
      (c): c is ModelAbility => !LEGACY_VALUES.has(c)
    )
  } catch {
    // 手改数据库导致的坏 JSON 按无能力处理，不让整个列表崩掉
  }
  return {
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName,
    type: row.type as ModelType,
    abilities,
    contextWindow: row.contextWindow,
    enabled: row.enabled,
    isBuiltin: row.isBuiltin,
    sortOrder: row.sortOrder
  }
}

/**
 * 按勾选结果整定某供应商的模型清单。
 *
 * 勾选的:已有则启用并按传入更新类型/能力/上下文,没有则新建(缺省时
 * 按模型名推断)。未勾选的:置为停用而不是删除——删了会连带丢掉
 * 用户改过的配置,而停用是可逆的。
 */
export function setModelSelection(providerId: string, selections: ModelSelection[]): Model[] {
  const db = getDb()
  const existing = listModels(providerId)
  const wanted = new Map(selections.map((s) => [s.modelId, s]))

  for (const m of existing) {
    const sel = wanted.get(m.modelId)
    /*
     * 存量修复:窗口还停在老的一刀切默认值时,按家族推断顺手升级。
     * 窗口记小了不是无害的——token 熔断按 5× 窗口触发,64k 记账的
     * 400k 模型会动不动就"累计输入超预算"提前停轮。
     */
    const upgraded =
      !sel?.contextWindow && m.contextWindow === LEGACY_DEFAULT_WINDOW
        ? (inferContextWindow(m.modelId) ?? LEGACY_DEFAULT_WINDOW)
        : LEGACY_DEFAULT_WINDOW
    db.update(models)
      .set({
        enabled: sel != null,
        ...(sel?.type ? { type: sel.type } : {}),
        ...(sel?.abilities ? { capabilities: JSON.stringify(sel.abilities) } : {}),
        ...(sel?.contextWindow
          ? { contextWindow: sel.contextWindow }
          : upgraded > LEGACY_DEFAULT_WINDOW
            ? { contextWindow: upgraded }
            : {}),
        ...(sel?.displayName ? { displayName: sel.displayName } : {}),
        updatedAt: sql`(datetime('now'))`
      })
      .where(eq(models.id, m.id))
      .run()
    wanted.delete(m.modelId)
  }

  let order = existing.length
  for (const sel of wanted.values()) {
    const inferred = inferModelMeta(sel.modelId)
    db.insert(models)
      .values({
        providerId,
        modelId: sel.modelId,
        displayName: sel.displayName ?? sel.modelId,
        type: sel.type ?? inferred.type,
        capabilities: JSON.stringify(sel.abilities ?? inferred.abilities),
        contextWindow: sel.contextWindow ?? inferContextWindow(sel.modelId) ?? 64000,
        isBuiltin: false,
        sortOrder: order++
      })
      .onConflictDoNothing()
      .run()
  }
  return listModels(providerId)
}

export function listModels(providerId?: string): Model[] {
  const db = getDb()
  const query = db.select().from(models).orderBy(asc(models.sortOrder), asc(models.createdAt))
  const rows = providerId ? query.where(eq(models.providerId, providerId)).all() : query.all()
  return rows.map(toView)
}

export function getModel(id: string): Model | null {
  const row = getDb().select().from(models).where(eq(models.id, id)).get()
  return row ? toView(row) : null
}

export function getModelByRef(providerId: string, modelId: string): Model | null {
  const row = getDb()
    .select()
    .from(models)
    .where(sql`${models.providerId} = ${providerId} AND ${models.modelId} = ${modelId}`)
    .get()
  return row ? toView(row) : null
}

export function createModel(input: CreateModelInput): Model {
  const inferred = inferModelMeta(input.modelId)
  return toView(
    getDb()
      .insert(models)
      .values({
        providerId: input.providerId,
        modelId: input.modelId,
        displayName: input.displayName ?? input.modelId,
        type: input.type ?? inferred.type,
        capabilities: JSON.stringify(input.abilities ?? inferred.abilities),
        contextWindow: input.contextWindow ?? inferContextWindow(input.modelId) ?? 64000,
        isBuiltin: false
      })
      .returning()
      .get()
  )
}
