import { describe, expect, it, vi } from 'vitest'
import { buildCaptureTools } from './capture-tools'
import type { CaptureResult } from '../preview/capture'

function call(tools: ReturnType<typeof buildCaptureTools>, input: unknown): Promise<unknown> {
  const entry = tools['capture_preview']
  return entry!.execute!(input as never, { toolCallId: 't', messages: [] } as never)
}

const PNG = Buffer.from('fake-png')

describe('capture_preview', () => {
  it('没有文件时不开窗口', async () => {
    const capture = vi.fn()
    const tools = buildCaptureTools({ sessionId: 's1', hasFiles: () => false, capture })
    const out = await call(tools, {})
    expect(out).toContain('还没有任何文件')
    expect(capture).not.toHaveBeenCalled()
  })

  it('缺省拍桌面视口的入口页,结果带图片块', async () => {
    const capture = vi.fn(async (): Promise<CaptureResult> => ({
      png: PNG,
      error: null,
      ready: true
    }))
    const tools = buildCaptureTools({ sessionId: 's1', hasFiles: () => true, capture })
    const out = (await call(tools, {})) as {
      type: string
      value: { type: string; text?: string; mediaType?: string }[]
    }

    expect(capture).toHaveBeenCalledWith('preview://session/s1/', { width: 1280, height: 800 })
    expect(out.type).toBe('content')
    expect(out.value[0].text).toContain('1280×800')
    expect(out.value[1]).toMatchObject({ type: 'file', mediaType: 'image/png' })
  })

  it('mobile 视口与指定页面', async () => {
    const capture = vi.fn(async (): Promise<CaptureResult> => ({
      png: PNG,
      error: null,
      ready: true
    }))
    const tools = buildCaptureTools({ sessionId: 's1', hasFiles: () => true, capture })
    await call(tools, { viewport: 'mobile', path: 'mobile.html' })
    expect(capture).toHaveBeenCalledWith('preview://session/s1/mobile.html', {
      width: 390,
      height: 844
    })
  })

  it('页面报错时照样交图,并把错误文本带给模型', async () => {
    const capture = vi.fn(async (): Promise<CaptureResult> => ({
      png: PNG,
      error: 'ReferenceError: x',
      ready: false
    }))
    const tools = buildCaptureTools({ sessionId: 's1', hasFiles: () => true, capture })
    const out = (await call(tools, {})) as { value: { text?: string }[] }
    expect(out.value[0].text).toContain('页面报错了')
    expect(out.value[0].text).toContain('ReferenceError')
  })

  it('截图本身失败时返回错误文本,不抛', async () => {
    const capture = vi.fn(async (): Promise<CaptureResult> => {
      throw new Error('窗口创建失败')
    })
    const tools = buildCaptureTools({ sessionId: 's1', hasFiles: () => true, capture })
    const out = await call(tools, {})
    expect(out).toContain('错误:截图失败')
    expect(out).toContain('窗口创建失败')
  })
})
