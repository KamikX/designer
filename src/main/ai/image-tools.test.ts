import { describe, expect, it, vi } from 'vitest'

// resolveAsset 会碰 better-sqlite3 与文件系统,这里替掉——被测的是工具的
// 白名单与返回形状,不是存储层
vi.mock('../storage/service', () => ({
  resolveAsset: vi.fn(async (id: string) =>
    id === 'A1' ? { data: Buffer.from([1, 2, 3]), mime: 'image/png' } : null
  )
}))

const { buildImageTools } = await import('./image-tools')

/**
 * view_image 的关键不是"能不能取到图",是**只能取到本会话出现过的图**。
 * 没有这个白名单,模型就有了一个拿任意 asset id 读本地资源的口子。
 */

interface Harness {
  notes: { assetId: string; description: string }[]
  call: (name: string, input: unknown) => Promise<unknown>
}

function harness(
  assets: { assetId: string; name: string; description?: string }[] = [
    { assetId: 'A1', name: '参考稿.png' }
  ]
): Harness {
  const notes: Harness['notes'] = []
  const tools = buildImageTools({
    assets,
    onNote: (assetId, description) => notes.push({ assetId, description })
  })
  const call = async (name: string, input: unknown): Promise<unknown> =>
    tools[name].execute!(input as never, { toolCallId: 't', messages: [] } as never)
  return { notes, call }
}

describe('view_image', () => {
  it('取到图时返回可直接喂给模型的图片内容块', async () => {
    const out = (await harness().call('view_image', { asset_id: 'A1' })) as {
      type: string
      value: { type: string; mediaType?: string }[]
    }

    expect(out.type).toBe('content')
    expect(out.value[0].type).toBe('text')
    expect(out.value[1]).toMatchObject({ type: 'file', mediaType: 'image/png' })
  })

  it('白名单之外的 id 一律拒绝,并列出可用的', async () => {
    const out = await harness().call('view_image', { asset_id: '别人的图' })
    expect(String(out)).toContain('没有这张参考图')
    expect(String(out)).toContain('A1(参考稿.png)')
  })

  it('本会话没有图时说清楚', async () => {
    const out = await harness([]).call('view_image', { asset_id: 'A1' })
    expect(String(out)).toContain('没有提供过参考图')
  })

  it('白名单里有但文件取不回来时给出可读原因', async () => {
    const out = await harness([{ assetId: 'GONE', name: '丢了.png' }]).call('view_image', {
      asset_id: 'GONE'
    })
    expect(String(out)).toContain('已经取不到了')
  })
})

describe('note_image', () => {
  it('把描述交给回调落库', async () => {
    const h = harness()
    const out = await h.call('note_image', { asset_id: 'A1', description: '  深色、留白多  ' })

    expect(h.notes).toEqual([{ assetId: 'A1', description: '深色、留白多' }])
    expect(String(out)).toContain('已记下')
  })

  it('白名单之外的 id 不写入', async () => {
    const h = harness()
    await h.call('note_image', { asset_id: '野的', description: 'x' })
    expect(h.notes).toEqual([])
  })
})
