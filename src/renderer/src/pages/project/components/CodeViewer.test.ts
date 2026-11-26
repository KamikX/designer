// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useChatStore } from '@renderer/stores/chat'
import CodeViewer from './CodeViewer.vue'

const mock = vi.hoisted(() => ({
  model: null as { uri: { path: string }; content: string; getLineCount: () => number } | null,
  change: () => {},
  command: () => {},
  save: vi.fn().mockResolvedValue(undefined),
  updateOptions: vi.fn(),
  models: new Map<string, { uri: { path: string }; content: string; getLineCount: () => number }>()
}))
vi.mock('@renderer/components/config/config', () => ({
  useAppConfig: () => ({ dark: ref(false) })
}))
vi.mock('@renderer/composables/useCodeEdits', () => ({ useCodeEdits: () => ({ save: mock.save }) }))
vi.mock('@renderer/monaco/highlighter', () => ({
  applyTheme: vi.fn(),
  ensureHighlighter: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('@renderer/monaco/setup', () => ({
  monaco: {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Range: class {},
    editor: {
      create: () => ({
        setModel: (model: typeof mock.model) => {
          mock.model = model
        },
        getModel: () => mock.model,
        getValue: () => mock.model!.content,
        onDidChangeModelContent: (callback: () => void) => {
          mock.change = callback
        },
        addCommand: (_key: number, callback: () => void) => {
          mock.command = callback
        },
        createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
        updateOptions: mock.updateOptions,
        revealLine: vi.fn(),
        revealLineInCenterIfOutsideViewport: vi.fn(),
        dispose: vi.fn()
      })
    }
  }
}))
vi.mock('@renderer/monaco/vfs', () => ({
  setScope: vi.fn(),
  getModel: (path: string, content: string) => {
    const model = mock.models.get(path) ?? {
      uri: { path: `/${path}` },
      content,
      getLineCount: () => 1
    }
    model.content = content
    mock.models.set(path, model)
    mock.change()
    return model
  },
  setContent: (path: string, content: string) => {
    const model = mock.models.get(path)
    if (!model || model.content === content) return false
    model.content = content
    mock.change()
    return true
  },
  applyPatch: (path: string, oldText: string, newText: string) => {
    const model = mock.models.get(path)
    if (!model) return null
    model.content = model.content.replace(oldText, newText)
    mock.change()
    return { startLine: 1, endLine: 1 }
  }
}))

beforeEach(() => {
  setActivePinia(createPinia())
  mock.models.clear()
  mock.model = null
  mock.change = () => {}
  mock.command = () => {}
  mock.save.mockClear()
  mock.updateOptions.mockClear()
})

async function setup(path = 'App.vue'): Promise<{
  store: ReturnType<typeof useArtifactStore>
  wrapper: ReturnType<typeof mount>
}> {
  const store = useArtifactStore()
  store.projectId = 'p'
  store.currentId = 'v1'
  store.files = [
    { path, content: 'original' },
    { path: 'theme.css', content: 'styles' }
  ]
  store.selectedPath = path
  const wrapper = mount(CodeViewer)
  await flushPromises()
  return { store, wrapper }
}

describe('manual code editor', () => {
  it.each(['index.html', 'App.vue', 'App.tsx'])(
    'keeps edits for %s across files and remounts',
    async (path) => {
      const { store, wrapper } = await setup(path)
      expect(store.dirty).toBe(false)
      mock.model!.content = 'manual edit'
      mock.change()
      expect(store.selectedContent).toBe('manual edit')
      store.selectedPath = 'theme.css'
      await flushPromises()
      store.selectedPath = path
      await flushPromises()
      expect(mock.model!.content).toBe('manual edit')
      wrapper.unmount()
      const remounted = mount(CodeViewer)
      await flushPromises()
      expect(mock.model!.content).toBe('manual edit')
      store.discardEdits()
      await flushPromises()
      expect(mock.model!.content).toBe('original')
      expect(store.dirty).toBe(false)
      remounted.unmount()
    }
  )

  it('suppresses programmatic patches and disables editing for the whole AI stream', async () => {
    const { store, wrapper } = await setup()
    const chat = useChatStore()
    chat.projectId = 'p'
    chat.conversationId = 'c'
    chat.sendingConversations = ['c']
    await flushPromises()
    expect(mock.updateOptions).toHaveBeenLastCalledWith({ readOnly: true, domReadOnly: true })
    chat.sendingConversations = []
    chat.streams = {
      c: {
        streamId: 's',
        projectId: 'p',
        conversationId: 'c',
        assistantMessageId: 'a',
        parts: [],
        activities: [],
        reasoning: ''
      }
    }
    store.applyStreamEvent(
      {
        type: 'file-patch',
        streamId: 's',
        path: 'App.vue',
        oldText: 'original',
        newText: 'AI edit'
      },
      'p'
    )
    await flushPromises()
    expect(store.dirty).toBe(false)
    expect(mock.model!.content).toBe('AI edit')
    wrapper.unmount()
  })

  it('runs the save shortcut only when manual editing is available', async () => {
    const { store, wrapper } = await setup()
    mock.command()
    expect(mock.save).toHaveBeenCalledOnce()
    store.saving = true
    mock.command()
    expect(mock.save).toHaveBeenCalledOnce()
    wrapper.unmount()
  })
})
