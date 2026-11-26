// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, shallowMount, flushPromises, DOMWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useChatStore } from '@renderer/stores/chat'
import CodeViewer from './CodeViewer.vue'
import WorkspacePane from './WorkspacePane.vue'
import type { Project, Artifact } from '@shared/types'
import { App } from 'antdv-next'
import { useCodeSelectionStore } from '@renderer/stores/code-selection'

const mock = vi.hoisted(() => ({
  model: null as { uri: { path: string }; content: string; getLineCount: () => number } | null,
  change: () => {},
  selectionChange: () => {},
  selection: null as null | {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
    isEmpty: () => boolean
  },
  confirmEdits: vi.fn().mockResolvedValue(true),
  info: vi.fn(),
  command: () => {},
  save: vi.fn().mockResolvedValue(undefined),
  updateOptions: vi.fn(),
  setPosition: vi.fn(),
  setSelection: vi.fn(),
  revealPositionInCenter: vi.fn(),
  focus: vi.fn(),
  highlighterReady: () => Promise.resolve(),
  models: new Map<string, { uri: { path: string }; content: string; getLineCount: () => number }>()
}))
vi.mock('@renderer/components/config/config', () => ({
  useAppConfig: () => ({ dark: ref(false) })
}))
vi.mock('@renderer/composables/useCodeEdits', () => ({
  useCodeEdits: () => ({ save: mock.save, confirmEdits: mock.confirmEdits })
}))
vi.mock('@renderer/monaco/highlighter', () => ({
  applyTheme: vi.fn(),
  ensureHighlighter: () => mock.highlighterReady()
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
        getSelection: () => mock.selection,
        onDidChangeCursorSelection: (callback: () => void) => {
          mock.selectionChange = callback
        },
        getValue: () => mock.model!.content,
        onDidChangeModelContent: (callback: () => void) => {
          mock.change = callback
        },
        addCommand: (_key: number, callback: () => void) => {
          mock.command = callback
        },
        createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
        updateOptions: mock.updateOptions,
        setPosition: mock.setPosition,
        setSelection: mock.setSelection,
        revealPositionInCenter: mock.revealPositionInCenter,
        focus: mock.focus,
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
      validatePosition: (position: unknown) => position,
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
  vi.spyOn(App, 'useApp').mockReturnValue({ message: { info: mock.info } } as unknown as ReturnType<
    typeof App.useApp
  >)
  mock.selection = null
  mock.selectionChange = () => {}
  mock.info.mockClear()
  mock.confirmEdits.mockReset().mockResolvedValue(true)
  mock.models.clear()
  mock.model = null
  mock.change = () => {}
  mock.command = () => {}
  mock.save.mockClear()
  mock.updateOptions.mockClear()
  mock.setPosition.mockClear()
  mock.setSelection.mockClear()
  mock.revealPositionInCenter.mockClear()
  mock.focus.mockClear()
  mock.highlighterReady = () => Promise.resolve()
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
  const actionsTarget = document.createElement('div')
  const wrapper = mount(CodeViewer, { props: { actionsTarget } })
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

describe('preview source navigation', () => {
  it('waits for Monaco initialization before navigating without creating drafts', async () => {
    let ready!: () => void
    mock.highlighterReady = () => new Promise<void>((resolve) => (ready = resolve))
    const store = useArtifactStore()
    store.projectId = 'p'
    store.currentId = 'v1'
    store.files = [{ path: 'shared/components/PageHeader.vue', content: 'original' }]
    store.selectedPath = store.files[0].path
    const wrapper = mount(CodeViewer, {
      props: {
        navigation: {
          projectId: 'p',
          artifactId: 'v1',
          path: store.selectedPath,
          line: 8,
          column: 3
        }
      }
    })
    expect(mock.setPosition).not.toHaveBeenCalled()
    ready()
    await flushPromises()
    expect(mock.setPosition).toHaveBeenCalledWith({ lineNumber: 8, column: 3 })
    expect(mock.revealPositionInCenter).toHaveBeenCalledWith({ lineNumber: 8, column: 3 })
    expect(mock.focus).toHaveBeenCalledOnce()
    expect(wrapper.emitted('navigated')).toHaveLength(1)
    expect(store.dirty).toBe(false)
    await wrapper.setProps({ navigation: null })
    store.selectedPath = ''
    store.selectedPath = store.files[0].path
    await flushPromises()
    expect(mock.focus).toHaveBeenCalledOnce()
    wrapper.unmount()
  })

  it.each([
    { projectId: 'other', artifactId: 'v1', path: 'App.vue' },
    { projectId: 'p', artifactId: 'old', path: 'App.vue' },
    { projectId: 'p', artifactId: 'v1', path: 'theme.css' }
  ])('ignores a navigation request for a different owner or file: %j', async (target) => {
    const { wrapper } = await setup()
    await wrapper.setProps({ navigation: { ...target, line: 8, column: 3 } })
    expect(mock.setPosition).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

function selectionButton(wrapper: ReturnType<typeof mount>): DOMWrapper<HTMLButtonElement> {
  return new DOMWrapper(
    (wrapper.props() as { actionsTarget: HTMLElement }).actionsTarget.querySelector('button')!
  )
}

function selectCode(empty = false): void {
  mock.selection = {
    startLineNumber: 1,
    startColumn: 2,
    endLineNumber: 1,
    endColumn: 5,
    isEmpty: () => empty
  }
  mock.selectionChange()
}

describe('code range context', () => {
  it('keeps the action outside Monaco and only enables it for a nonempty selection', async () => {
    const { store, wrapper } = await setup()
    const button = selectionButton(wrapper).element
    expect(wrapper.find('.code-selection-toolbar').exists()).toBe(false)
    expect(wrapper.get('.code-viewer').element.contains(button)).toBe(false)
    const editorNodes = [...wrapper.get('.code-viewer').element.childNodes]
    selectCode(true)
    await flushPromises()
    expect(selectionButton(wrapper).element.disabled).toBe(true)
    selectCode()
    await flushPromises()
    expect(selectionButton(wrapper).element).toBe(button)
    expect([...wrapper.get('.code-viewer').element.childNodes]).toEqual(editorNodes)
    await selectionButton(wrapper).trigger('click')
    expect(useCodeSelectionStore().selections).toEqual([
      expect.objectContaining({ path: 'App.vue', startLine: 1, startColumn: 2, endColumn: 5 })
    ])
    expect(store.dirty).toBe(false)
    wrapper.unmount()
    expect(useCodeSelectionStore().selections).toHaveLength(1)
  })

  it('requires a fresh selection after saving unsaved code and preserves it on cancel', async () => {
    const { store, wrapper } = await setup()
    store.editFile('App.vue', 'draft code')
    selectCode()
    await flushPromises()
    mock.confirmEdits.mockResolvedValueOnce(false)
    await selectionButton(wrapper).trigger('click')
    await flushPromises()
    expect(selectionButton(wrapper).element.disabled).toBe(false)
    await selectionButton(wrapper).trigger('click')
    await flushPromises()
    expect(mock.confirmEdits).toHaveBeenCalledTimes(2)
    expect(mock.info).toHaveBeenCalledOnce()
    expect(useCodeSelectionStore().selections).toEqual([])
    expect(selectionButton(wrapper).element.disabled).toBe(true)
    wrapper.unmount()
  })
})

it.each([
  { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
  { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 }
])('preserves whole-line and multiline selections through the header action: %j', async (range) => {
  const { store, wrapper } = await setup()
  store.files[0].content = 'first line\nsecond line\nthird line'
  await flushPromises()
  mock.selection = { ...range, isEmpty: () => false }
  mock.selectionChange()
  await flushPromises()
  const button = selectionButton(wrapper)
  expect(button.element.disabled).toBe(false)
  await button.trigger('mousedown')
  expect(useCodeSelectionStore().selections).toHaveLength(0)
  await button.trigger('click')
  expect(useCodeSelectionStore().selections).toEqual([
    expect.objectContaining({
      startLine: range.startLineNumber,
      startColumn: 1,
      endLine: range.endLineNumber,
      endColumn: 1
    })
  ])
  expect(store.dirty).toBe(false)
  wrapper.unmount()
})

it('selects the entire requested code range and reveals its start without changing code', async () => {
  const { store, wrapper } = await setup()
  await wrapper.setProps({
    navigation: {
      projectId: 'p',
      artifactId: 'v1',
      path: 'App.vue',
      line: 2,
      column: 3,
      endLine: 5,
      endColumn: 1
    }
  })
  expect(mock.setSelection).toHaveBeenCalledWith({
    startLineNumber: 2,
    startColumn: 3,
    endLineNumber: 5,
    endColumn: 1
  })
  expect(mock.revealPositionInCenter).toHaveBeenCalledWith({ lineNumber: 2, column: 3 })
  expect(mock.focus).toHaveBeenCalledOnce()
  expect(store.dirty).toBe(false)
  wrapper.unmount()
})

it('opens code mode from a composer range and rejects stale navigation', async () => {
  const store = useArtifactStore()
  store.projectId = 'p'
  store.currentId = 'v1'
  store.artifacts = [{ id: 'v1' } as Artifact]
  store.files = [{ path: 'App.vue', content: 'original' }]
  vi.spyOn(store, 'loadForProject').mockResolvedValue(undefined)
  const selections = useCodeSelectionStore()
  selections.add('App.vue', { startLine: 1, startColumn: 2, endLine: 1, endColumn: 5 })
  const selection = { ...selections.selections[0] }
  const wrapper = shallowMount(WorkspacePane, {
    props: { project: { id: 'p', stack: 'vue3', libs: [] } as unknown as Project },
    global: {
      stubs: {
        ASplitter: { template: '<div><slot /></div>' },
        ASplitterPanel: { template: '<div><slot /></div>' }
      }
    }
  })
  expect(wrapper.findComponent(CodeViewer).exists()).toBe(false)
  await wrapper.setProps({ codeSelectionNavigation: selection })
  expect(store.selectedPath).toBe('App.vue')
  expect(wrapper.getComponent(CodeViewer).props('navigation')).toEqual({
    projectId: 'p',
    artifactId: 'v1',
    path: 'App.vue',
    line: 1,
    column: 2,
    endLine: 1,
    endColumn: 5
  })
  await wrapper.getComponent(CodeViewer).vm.$emit('navigated')
  await flushPromises()
  await wrapper.setProps({ codeSelectionNavigation: { ...selection, artifactId: 'old' } })
  expect(wrapper.getComponent(CodeViewer).props('navigation')).toBeNull()
  await wrapper.setProps({ codeSelectionNavigation: { ...selection } })
  expect(wrapper.getComponent(CodeViewer).props('navigation')).not.toBeNull()
  wrapper.unmount()
})
