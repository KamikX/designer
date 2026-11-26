// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { Artifact, ArtifactFile, ChatStreamEvent, DesignerApi, Project } from '@shared/types'
import { useArtifactStore } from './artifact'
import { useChatStore } from './chat'

/**
 * 这条边以前没人测:chat.test.ts 明写"只测活动相位,不把画布拖下水",
 * 而 artifact store 根本没有测试文件。于是**跨项目串代码**这个 bug
 * 一路活到了用户手上——A 项目的文件树里挂着 B 项目的文件、一直转圈,
 * 点开就是后台管理的代码。
 *
 * 这里钉的都是"错了就串项目"的不变量,不是覆盖率。
 */

function artifact(id: string, version: number): Artifact {
  return {
    id,
    projectId: 'p',
    messageId: null,
    version,
    baseArtifactId: null,
    summary: '',
    createdAt: '2026-07-27T00:00:00.000Z'
  }
}

function file(path: string, content: string): ArtifactFile {
  return { path, content }
}

/** 手动控制 resolve 时机,用来构造"晚到的回复" */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

const getProject = vi.fn<(id: string) => Promise<Project | null>>()
const saveSettings = vi.fn().mockResolvedValue(undefined)
const list = vi.fn<(projectId: string) => Promise<Artifact[]>>()
const saveEdits = vi.fn()
const files = vi.fn<(artifactId: string) => Promise<ArtifactFile[]>>()

beforeEach(() => {
  saveEdits.mockReset()
  list.mockReset()
  files.mockReset()
  getProject.mockReset().mockResolvedValue(null)
  saveSettings.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      artifact: { list, files, saveEdits },
      project: { get: getProject, saveSettings }
    } as unknown as DesignerApi
  })
  setActivePinia(createPinia())
})

function fileStart(path: string): ChatStreamEvent {
  return { streamId: 's', type: 'file-start', path }
}

describe('画布归属', () => {
  it('别的项目的流事件一律不画进来', () => {
    const store = useArtifactStore()
    store.projectId = 'A'
    store.selectedPath = 'App.vue'

    store.applyStreamEvent(fileStart('admin/Dashboard.vue'), 'B')

    expect(store.pending).toEqual([])
    // selectedPath 会跟着正在生成的文件走,串进来的话代码视图当场跳到别人的文件
    expect(store.selectedPath).toBe('App.vue')
  })

  it('纯聊天的流(没有项目)同样不碰画布', () => {
    const store = useArtifactStore()
    store.projectId = 'A'

    store.applyStreamEvent(fileStart('x.vue'), undefined)

    expect(store.pending).toEqual([])
  })

  it('本项目的流照常画', () => {
    const store = useArtifactStore()
    store.projectId = 'A'

    store.applyStreamEvent(fileStart('App.vue'), 'A')

    expect(store.pending).toEqual([{ path: 'App.vue', content: '', done: false }])
    expect(store.selectedPath).toBe('App.vue')
  })
})

describe('afterNewVersion', () => {
  it('不在本项目版本列表里的 artifactId 绝不 select', async () => {
    const store = useArtifactStore()
    store.projectId = 'A'
    store.files = [file('App.vue', '本项目的内容')]
    list.mockResolvedValue([artifact('a1', 1)])

    await store.afterNewVersion('别的项目的版本')

    // 一次都不该去拉那个版本的文件——拉了就等于把别的项目整份显示出来
    expect(files).not.toHaveBeenCalled()
    expect(store.files).toEqual([file('App.vue', '本项目的内容')])
  })

  it('是本项目的版本就正常切过去', async () => {
    const store = useArtifactStore()
    store.projectId = 'A'
    list.mockResolvedValue([artifact('a2', 2)])
    files.mockResolvedValue([file('App.vue', '新版本')])

    await store.afterNewVersion('a2')

    expect(store.currentId).toBe('a2')
    expect(store.files).toEqual([file('App.vue', '新版本')])
    expect(store.pending).toEqual([])
  })
})

describe('切项目', () => {
  it('同步阶段就清空视图真值,不让上一个项目的树多显示一帧', () => {
    const store = useArtifactStore()
    store.projectId = 'A'
    store.artifacts = [artifact('a1', 1)]
    store.currentId = 'a1'
    store.files = [file('App.vue', 'A 的内容')]
    store.selectedPath = 'App.vue'
    list.mockReturnValue(new Promise(() => {}))

    void store.loadForProject('B')

    expect(store.files).toEqual([])
    expect(store.currentId).toBe('')
    expect(store.selectedPath).toBe('')
    expect(store.artifacts).toEqual([])
  })

  it('晚到的回复不许翻案:A 的数据在切到 B 之后才回来', async () => {
    const store = useArtifactStore()
    const slowA = deferred<Artifact[]>()
    const fastB = deferred<Artifact[]>()
    list.mockImplementation((projectId) => (projectId === 'A' ? slowA.promise : fastB.promise))
    files.mockResolvedValue([file('B.vue', 'B 的内容')])

    const loadA = store.loadForProject('A')
    const loadB = store.loadForProject('B')

    fastB.resolve([artifact('b1', 1)])
    await loadB
    // A 的列表现在才回来
    slowA.resolve([artifact('a1', 1)])
    await loadA

    expect(store.projectId).toBe('B')
    expect(store.artifacts.map((a) => a.id)).toEqual(['b1'])
    expect(store.files).toEqual([file('B.vue', 'B 的内容')])
  })

  it('新项目还没有任何版本时,旧项目晚到的文件也不许落进来', async () => {
    const store = useArtifactStore()
    const slowFiles = deferred<ArtifactFile[]>()
    list.mockImplementation(async (projectId) => (projectId === 'A' ? [artifact('a1', 1)] : []))
    files.mockReturnValue(slowFiles.promise)

    const loadA = store.loadForProject('A')
    // A 的 files 还挂着,直接切到没有版本的 B(走的是 select('') 同步分支)
    await store.loadForProject('B')
    slowFiles.resolve([file('A.vue', 'A 的内容')])
    await loadA

    expect(store.currentId).toBe('')
    expect(store.files).toEqual([])
  })
})

describe('version selection', () => {
  it('commits identity and files together, retaining an existing selected path', async () => {
    const store = useArtifactStore()
    store.projectId = 'p'
    store.artifacts = [artifact('new', 2), artifact('old', 1)]
    store.currentId = 'new'
    store.files = [file('App.vue', 'new')]
    store.selectedPath = 'App.vue'
    const reply = deferred<ArtifactFile[]>()
    files.mockReturnValue(reply.promise)

    const selection = store.select('old')
    expect(store.loading).toBe(true)
    expect(store.currentId).toBe('new')
    expect(store.files[0].content).toBe('new')
    reply.resolve([file('App.vue', 'old')])
    await selection

    expect(store.currentId).toBe('old')
    expect(store.selectedPath).toBe('App.vue')
    expect(store.files[0].content).toBe('old')
    expect(store.loading).toBe(false)
  })

  it('preserves the displayed snapshot when loading fails', async () => {
    const store = useArtifactStore()
    store.artifacts = [artifact('new', 2), artifact('old', 1)]
    store.currentId = 'new'
    store.files = [file('App.vue', 'new')]
    files.mockRejectedValue(new Error('load failed'))
    await store.select('old')
    expect(store.currentId).toBe('new')
    expect(store.files[0].content).toBe('new')
    expect(store.loadError).toBe('load failed')
    expect(store.loading).toBe(false)
  })

  it('ignores an older request even when the same version is selected again', async () => {
    const store = useArtifactStore()
    store.artifacts = [artifact('a', 2), artifact('b', 1)]
    const slow = deferred<ArtifactFile[]>()
    files
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce([file('b', 'b')])
      .mockResolvedValueOnce([file('a', 'latest reply')])
    const first = store.select('a')
    await store.select('b')
    await store.select('a')
    slow.resolve([file('a', 'stale reply')])
    await first
    expect(store.files[0].content).toBe('latest reply')
    expect(store.selectedPath).toBe('a')
  })

  it('rejects IDs outside the loaded project list', async () => {
    const store = useArtifactStore()
    await store.select('foreign')
    expect(files).not.toHaveBeenCalled()
  })

  it('opens the newest snapshot again when re-entering a project', async () => {
    const store = useArtifactStore()
    list.mockResolvedValue([artifact('new', 2), artifact('old', 1)])
    files.mockImplementation(async (id) => [file(id, id)])
    await store.loadForProject('p')
    await store.select('old')
    await store.loadForProject('p')
    expect(store.currentId).toBe('new')
  })
})

describe('persisted version selection', () => {
  it('restores an older saved version and persists subsequent selections', async () => {
    const store = useArtifactStore()
    list.mockResolvedValue([artifact('new', 2), artifact('old', 1)])
    getProject.mockResolvedValue({ settings: { selectedArtifactId: 'old' } } as Project)
    files.mockImplementation(async (id) => [file('index.html', id)])
    await store.loadForProject('p')
    expect(store.currentId).toBe('old')
    expect(store.files[0].content).toBe('old')
    await store.select('new')
    expect(saveSettings).toHaveBeenLastCalledWith('p', { selectedArtifactId: 'new' })
  })

  it('falls back to the latest version when a saved selection is absent from this project', async () => {
    const store = useArtifactStore()
    list.mockResolvedValue([artifact('new', 2)])
    getProject.mockResolvedValue({ settings: { selectedArtifactId: 'foreign' } } as Project)
    files.mockResolvedValue([file('index.html', 'new')])
    await store.loadForProject('p')
    expect(store.currentId).toBe('new')
    expect(files).not.toHaveBeenCalledWith('foreign')
  })
})

describe('manual drafts', () => {
  function seed(): ReturnType<typeof useArtifactStore> {
    const store = useArtifactStore()
    store.projectId = 'p'
    store.currentId = 'v1'
    store.artifacts = [artifact('v1', 1)]
    store.files = [file('index.html', 'old'), file('theme.css', 'styles')]
    store.selectedPath = 'index.html'
    return store
  }

  it('keeps edits across file switches and clears dirty state when undone', () => {
    const store = seed()
    store.editFile('index.html', 'new')
    store.selectedPath = 'theme.css'
    store.editFile('theme.css', 'new styles')
    store.selectedPath = 'index.html'
    expect(store.selectedContent).toBe('new')
    expect(store.files[0].content).toBe('old')
    store.editFile('index.html', 'old')
    store.editFile('theme.css', 'styles')
    expect(store.dirty).toBe(false)
  })

  it('saves all edits as one version and selects it for subsequent operations', async () => {
    const store = seed()
    store.editFile('index.html', 'new')
    store.editFile('theme.css', '')
    saveEdits.mockResolvedValue(artifact('v2', 2))
    await store.saveEdits()
    expect(saveEdits).toHaveBeenCalledWith({
      projectId: 'p',
      baseArtifactId: 'v1',
      files: [file('index.html', 'new'), file('theme.css', '')]
    })
    expect(store.currentId).toBe('v2')
    expect(store.files).toEqual([file('index.html', 'new'), file('theme.css', '')])
    expect(store.dirty).toBe(false)
    expect(store.saving).toBe(false)
    expect(saveSettings).toHaveBeenCalledWith('p', { selectedArtifactId: 'v2' })
    const chat = useChatStore()
    chat.projectId = 'p'
    chat.conversationId = 'c'
    chat.selected = { providerId: 'provider', modelId: 'model' }
    const send = vi
      .fn()
      .mockResolvedValue({ streamId: 's', userMessageId: 'u', assistantMessageId: 'a' })
    Object.assign(window.api, { chat: { send } })
    await chat.send('Continue editing')
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ baseArtifactId: 'v2' }))
  })

  it('preserves drafts after a failed save', async () => {
    const store = seed()
    store.editFile('index.html', 'new')
    saveEdits.mockRejectedValue(new Error('disk full'))
    await expect(store.saveEdits()).rejects.toThrow('disk full')
    expect(store.selectedContent).toBe('new')
    expect(store.currentId).toBe('v1')
    expect(store.dirty).toBe(true)
    expect(store.saving).toBe(false)
  })

  it('ignores a save result arriving after another project was loaded', async () => {
    const store = seed()
    store.editFile('index.html', 'new')
    const response = deferred<Artifact>()
    saveEdits.mockReturnValue(response.promise)
    const saving = store.saveEdits()
    list.mockResolvedValue([])
    await store.loadForProject('other')
    response.resolve(artifact('v2', 2))
    await saving
    expect(store.projectId).toBe('other')
    expect(store.currentId).toBe('')
    expect(store.files).toEqual([])
    expect(store.saving).toBe(false)
  })

  it('blocks editing from submission through the end of generation', () => {
    const store = seed()
    const chat = useChatStore()
    chat.projectId = 'p'
    chat.conversationId = 'c'
    chat.sendingConversations = ['c']
    store.editFile('index.html', 'ignored')
    expect(store.dirty).toBe(false)
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
    store.editFile('index.html', 'ignored')
    expect(store.dirty).toBe(false)
    chat.streams = {}
    store.editFile('index.html', 'accepted')
    expect(store.dirty).toBe(true)
    store.discardEdits()
    expect(store.selectedContent).toBe('old')
  })

  it('does not save a clean snapshot or introduce unknown files', async () => {
    const store = seed()
    store.editFile('new.ts', 'ignored')
    await store.saveEdits()
    expect(saveEdits).not.toHaveBeenCalled()
  })
})
