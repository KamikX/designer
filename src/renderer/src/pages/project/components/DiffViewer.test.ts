// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { useArtifactStore } from '@renderer/stores/artifact'
import { useProjectStore } from '@renderer/stores/project'
import DiffViewer from './DiffViewer.vue'
import FileTree from './FileTree.vue'

const mock = vi.hoisted(() => ({
  createdModels: [] as {
    value: string
    language: string
    disposed: boolean
    dispose: () => void
  }[],
  currentModel: null as { original: unknown; modified: unknown } | null,
  updateOptions: vi.fn(),
  goToDiff: vi.fn(),
  disposeEditor: vi.fn()
}))

vi.mock('@renderer/components/config/config', () => ({
  useAppConfig: () => ({ dark: ref(false) })
}))
vi.mock('@renderer/monaco/highlighter', () => ({
  applyTheme: vi.fn(),
  ensureHighlighter: () => Promise.resolve()
}))
vi.mock('@renderer/monaco/setup', () => ({
  monaco: {
    Uri: { parse: (raw: string) => ({ path: raw }) },
    editor: {
      createModel: (value: string, language: string) => {
        const model = {
          value,
          language,
          disposed: false,
          dispose: () => {
            model.disposed = true
          }
        }
        mock.createdModels.push(model)
        return model
      },
      createDiffEditor: () => ({
        setModel: (model: typeof mock.currentModel) => {
          mock.currentModel = model
        },
        updateOptions: mock.updateOptions,
        goToDiff: mock.goToDiff,
        dispose: mock.disposeEditor
      })
    }
  }
}))

beforeEach(() => {
  setActivePinia(createPinia())
  mock.createdModels = []
  mock.currentModel = null
  mock.updateOptions.mockClear()
  mock.goToDiff.mockClear()
  mock.disposeEditor.mockClear()
})

describe('DiffViewer', () => {
  it('mounts Monaco diff models for changed files and disposes them on unmount', async () => {
    const store = useArtifactStore()
    store.projectId = 'p'
    store.currentId = 'v2'
    store.files = [{ path: 'App.vue', content: '<template>new</template>' }]
    store.diffBaseId = 'v1'
    store.diffBaseFiles = [{ path: 'App.vue', content: '<template>old</template>' }]
    store.selectedPath = 'App.vue'

    const wrapper = mount(DiffViewer, {
      props: { renderSideBySide: true },
      global: { stubs: { ASpin: true } }
    })
    await flushPromises()

    expect(mock.createdModels).toHaveLength(2)
    expect(mock.createdModels[0]).toMatchObject({
      value: '<template>old</template>',
      language: 'vue',
      disposed: false
    })
    expect(mock.createdModels[1]).toMatchObject({
      value: '<template>new</template>',
      language: 'vue',
      disposed: false
    })

    await wrapper.setProps({ renderSideBySide: false })
    expect(mock.updateOptions).toHaveBeenCalledWith({ renderSideBySide: false })

    wrapper.unmount()
    expect(mock.createdModels.every((m) => m.disposed)).toBe(true)
    expect(mock.disposeEditor).toHaveBeenCalledTimes(1)
  })
})

describe('FileTree diff mode', () => {
  it('shows A/M/D badges and includes deleted files in diff mode', () => {
    const store = useArtifactStore()
    const projectStore = useProjectStore()
    projectStore.current = {
      id: 'p',
      name: 'Demo',
      description: '',
      stack: 'vue3',
      designMode: 'prototype',
      targets: ['web'],
      libs: [],
      externalLibraries: [],
      styleBrief: '',
      designDocument: '',
      visualStylePriority: 'styleBrief',
      codeInstructions: '',
      settings: {},
      createdAt: '',
      updatedAt: ''
    }
    store.projectId = 'p'
    store.currentId = 'v2'
    store.artifacts = [
      {
        id: 'v2',
        projectId: 'p',
        messageId: null,
        version: 2,
        baseArtifactId: 'v1',
        summary: '',
        createdAt: ''
      }
    ]
    store.files = [
      { path: 'App.vue', content: 'new' },
      { path: 'Added.vue', content: 'added' },
      { path: 'Same.vue', content: 'same' }
    ]
    store.diffBaseId = 'v1'
    store.diffBaseFiles = [
      { path: 'App.vue', content: 'old' },
      { path: 'Removed.vue', content: 'gone' },
      { path: 'Same.vue', content: 'same' }
    ]

    const wrapper = mount(FileTree, {
      props: { mode: 'diff' },
      global: {
        stubs: {
          ASegmented: {
            props: ['value', 'options'],
            template: '<div class="segmented-stub" />'
          },
          ATree: {
            props: ['treeData'],
            template:
              '<div class="tree-stub"><div v-for="node in treeData[0]?.children ?? []" :key="node.key"><slot name="titleRender" v-bind="node" /></div></div>'
          }
        }
      }
    })

    const text = wrapper.text()
    expect(text).toContain('App.vue')
    expect(text).toContain('Added.vue')
    expect(text).toContain('Removed.vue')
    expect(text).not.toContain('Same.vue')
    expect(wrapper.findAll('.file-diff-badge').map((n) => n.text())).toEqual(['A', 'M', 'D'])
  })
})
