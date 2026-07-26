// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, shallowRef } from 'vue'
import { Modal, Select } from 'antdv-next'
import { useCollabStore } from '@renderer/stores/collab'
import { useProviderStore } from '@renderer/stores/provider'
import type {
  Conversation,
  CreateGroupInput,
  DesignerApi,
  GroupMemberTemplate,
  InstalledSkill,
  Model,
  Provider
} from '@shared/types'
import type { MemberDraft } from '../member-drafts'
import GroupMemberEditor from './GroupMemberEditor.vue'
import GroupMemberList from './GroupMemberList.vue'
import CreateGroupModal from './CreateGroupModal.vue'

const appMessage = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn()
}))

vi.mock('antdv-next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antdv-next')>()
  return {
    ...actual,
    App: Object.assign({}, actual.App, {
      useApp: () => ({ message: appMessage })
    })
  }
})

const template: GroupMemberTemplate = {
  id: 'pm',
  name: '产品经理',
  color: '#e8662c',
  duty: '梳理需求',
  deliverable: '需求文档',
  persona: '你是产品经理'
}

const provider: Provider = {
  id: 'provider-1',
  slug: 'provider',
  name: '测试供应商',
  adapter: 'openai-compatible',
  baseUrl: null,
  hasKey: true,
  keyStorage: 'safe',
  keyHint: null,
  enabled: true,
  isBuiltin: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const toolsModel: Model = {
  id: 'model-row-1',
  providerId: provider.id,
  modelId: 'provider-model',
  displayName: '工具模型',
  type: 'chat',
  abilities: ['tools'],
  contextWindow: 128000,
  enabled: true,
  isBuiltin: false,
  sortOrder: 0
}

const installedSkills: InstalledSkill[] = [
  {
    name: 'app-skill',
    description: '应用技能',
    source: 'app',
    dir: '/skills/app'
  },
  {
    name: 'agents-skill',
    description: '共享技能',
    source: 'agents',
    dir: '/skills/agents'
  },
  {
    name: 'builtin-skill',
    description: '内置技能',
    source: 'builtin',
    dir: '/skills/builtin'
  }
]

const createdGroup: Conversation = {
  id: 'group-1',
  projectId: null,
  title: '设计协作',
  kind: 'group',
  settings: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

const createGroup = vi
  .fn<(input: CreateGroupInput) => Promise<Conversation>>()
  .mockResolvedValue(createdGroup)

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      market: {
        installedSkills: vi.fn(async () => installedSkills)
      },
      group: {
        create: createGroup
      }
    } as unknown as DesignerApi
  })
}

function prepareStores(): ReturnType<typeof createPinia> {
  const pinia = createPinia()
  setActivePinia(pinia)

  const collab = useCollabStore()
  collab.roles = [template]

  const providerStore = useProviderStore()
  providerStore.providers = [provider]
  providerStore.models = [toolsModel]
  providerStore.loaded = true
  return pinia
}

function editableMember(overrides: Partial<MemberDraft> = {}): MemberDraft {
  return {
    tempKey: 'member-1',
    name: '产品经理',
    color: '#e8662c',
    duty: '梳理需求',
    deliverable: '需求文档',
    persona: '你是产品经理',
    modelRowId: '',
    skillIds: [],
    ...overrides
  }
}

function page(): DOMWrapper<HTMLElement> {
  return new DOMWrapper(document.body)
}

async function clickModalOk(): Promise<void> {
  await page().get('.ant-modal-footer .ant-btn-primary').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  installApi()
  createGroup.mockReset()
  createGroup.mockResolvedValue(createdGroup)
  appMessage.warning.mockClear()
  appMessage.error.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('GroupMemberEditor', () => {
  it('用 label 或 aria-label 标记核心编辑控件', () => {
    const wrapper = mount(GroupMemberEditor, {
      props: {
        modelValue: editableMember(),
        modelGroups: [{ provider, models: [toolsModel] }],
        skills: installedSkills
      }
    })

    expect(wrapper.get('label[for="member-name"]').text()).toContain('名称')
    expect(wrapper.get('#member-name').attributes('aria-label')).toBe('成员名称')
    expect(wrapper.get('label[for="member-persona"]').text()).toContain('人设')
    expect(wrapper.get('#member-persona').attributes('aria-label')).toBe('成员人设')
    expect(wrapper.get('label[for="member-model"]').text()).toContain('模型')
    expect(wrapper.get('input#member-model').attributes('role')).toBe('combobox')
    expect(wrapper.get('label[for="member-skills"]').text()).toContain('技能')
    expect(wrapper.get('input#member-skills').attributes('role')).toBe('combobox')
  })

  it('通过 v-model 修改字段，并只提供 tools 模型和非 builtin 技能', async () => {
    const current = shallowRef(editableMember())
    const Host = defineComponent(
      () => () =>
        h(GroupMemberEditor, {
          modelValue: current.value,
          modelGroups: [{ provider, models: [toolsModel] }],
          skills: installedSkills,
          'onUpdate:modelValue': (value: MemberDraft) => {
            current.value = value
          }
        })
    )
    const wrapper = mount(Host)

    await wrapper.get('[data-testid="member-name"]').setValue('需求策划')
    await wrapper.get('[data-testid="member-persona"]').setValue('负责需求拆解')

    const selects = wrapper.findAllComponents(Select)
    expect(selects).toHaveLength(2)
    selects[0].vm.$emit('update:value', toolsModel.id)
    await flushPromises()
    selects[1].vm.$emit('update:value', ['app-skill', 'agents-skill'])
    await flushPromises()

    expect(current.value).toMatchObject({
      name: '需求策划',
      persona: '负责需求拆解',
      modelRowId: toolsModel.id,
      skillIds: ['app-skill', 'agents-skill']
    })
    expect(selects[1].props('options')).not.toContainEqual(
      expect.objectContaining({
        options: expect.arrayContaining([expect.objectContaining({ value: 'builtin-skill' })])
      })
    )
  })
})

describe('GroupMemberList', () => {
  it('卡片容器不是冗余的点击入口', async () => {
    const wrapper = mount(GroupMemberList, { props: { members: [editableMember()] } })

    await wrapper.get('.member-card').trigger('click')

    expect(wrapper.emitted('edit')).toBeUndefined()
  })

  it('只通过事件上报编辑、删除和移动操作', async () => {
    const members = [editableMember(), editableMember({ tempKey: 'member-2', name: 'UI 设计师' })]
    const wrapper = mount(GroupMemberList, { props: { members } })

    await wrapper.get('[data-testid="edit-member-1"]').trigger('click')
    await wrapper.get('[data-testid="remove-member-1"]').trigger('click')
    await wrapper.get('[data-testid="move-down-member-1"]').trigger('click')

    expect(wrapper.emitted('edit')).toEqual([['member-1']])
    expect(wrapper.emitted('remove')).toEqual([['member-1']])
    expect(wrapper.emitted('move')).toEqual([['member-1', 'down']])
    expect(members).toHaveLength(2)
  })
})

describe('CreateGroupModal', () => {
  it('群名输入可由标签定位', async () => {
    const pinia = prepareStores()
    mount(CreateGroupModal, {
      attachTo: document.body,
      props: { open: true },
      global: { plugins: [pinia] }
    })
    await flushPromises()

    expect(page().get('label[for="group-name"]').text()).toContain('群组名称')
    expect(page().get('#group-name').attributes('aria-label')).toBe('群组名称')
  })

  it('从模板或空白新增成员，并在新增后打开对应编辑区', async () => {
    const pinia = prepareStores()
    const wrapper = mount(CreateGroupModal, {
      attachTo: document.body,
      props: { open: true },
      global: { plugins: [pinia] }
    })
    await flushPromises()

    await page().get('[data-testid="add-template-pm"]').trigger('click')
    expect(wrapper.findComponent(GroupMemberList).props('members')).toHaveLength(1)
    expect(wrapper.findComponent(GroupMemberEditor).props('modelValue').name).toBe('产品经理')

    await page().get('[data-testid="add-blank-member"]').trigger('click')
    expect(wrapper.findComponent(GroupMemberList).props('members')).toHaveLength(2)
    expect(wrapper.findComponent(GroupMemberEditor).props('modelValue').name).toBe('')
  })

  it('重复名称或缺少有效模型时不提交', async () => {
    const pinia = prepareStores()
    const wrapper = mount(CreateGroupModal, {
      attachTo: document.body,
      props: { open: true },
      global: { plugins: [pinia] }
    })
    await flushPromises()

    await page().get('[data-testid="group-name"]').setValue('设计协作')
    await page().get('[data-testid="add-template-pm"]').trigger('click')
    await clickModalOk()

    expect(createGroup).not.toHaveBeenCalled()
    expect(appMessage.warning).toHaveBeenCalledWith('请为“产品经理”选择支持工具调用的模型')

    wrapper.findComponent(GroupMemberEditor).vm.$emit('update:modelValue', {
      ...wrapper.findComponent(GroupMemberEditor).props('modelValue'),
      modelRowId: toolsModel.id
    })
    await page().get('[data-testid="add-template-pm"]').trigger('click')
    await clickModalOk()

    expect(createGroup).not.toHaveBeenCalled()
    expect(appMessage.warning).toHaveBeenLastCalledWith('成员名称不能重复')
  })

  it('提交 plain payload，不携带 UI 临时 key', async () => {
    const pinia = prepareStores()
    const wrapper = mount(CreateGroupModal, {
      attachTo: document.body,
      props: { open: true },
      global: { plugins: [pinia] }
    })
    await flushPromises()

    await page().get('[data-testid="group-name"]').setValue(' 设计协作 ')
    await page().get('[data-testid="add-blank-member"]').trigger('click')
    wrapper.findComponent(GroupMemberEditor).vm.$emit(
      'update:modelValue',
      editableMember({
        tempKey: wrapper.findComponent(GroupMemberEditor).props('modelValue').tempKey,
        name: ' 需求策划 ',
        modelRowId: toolsModel.id,
        skillIds: ['app-skill', 'agents-skill']
      })
    )
    await clickModalOk()

    expect(createGroup).toHaveBeenCalledWith({
      name: '设计协作',
      members: [
        {
          name: '需求策划',
          color: '#e8662c',
          duty: '梳理需求',
          deliverable: '需求文档',
          persona: '你是产品经理',
          modelRowId: toolsModel.id,
          skillIds: ['app-skill', 'agents-skill']
        }
      ]
    })
    expect(createGroup.mock.calls[0]?.[0].members[0]).not.toHaveProperty('tempKey')
  })

  it('快速触发两次提交时只创建并通知一次', async () => {
    const pinia = prepareStores()
    let resolveCreate: ((group: Conversation) => void) | undefined
    createGroup.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      })
    )
    const onCreated = vi.fn()
    const wrapper = mount(CreateGroupModal, {
      attachTo: document.body,
      props: { open: true, onCreated },
      global: { plugins: [pinia] }
    })
    await flushPromises()

    await page().get('[data-testid="group-name"]').setValue('设计协作')
    await page().get('[data-testid="add-template-pm"]').trigger('click')
    wrapper.findComponent(GroupMemberEditor).vm.$emit('update:modelValue', {
      ...wrapper.findComponent(GroupMemberEditor).props('modelValue'),
      modelRowId: toolsModel.id
    })

    const modal = wrapper.findComponent(Modal)
    modal.vm.$emit('ok')
    modal.vm.$emit('ok')
    await flushPromises()

    expect(createGroup).toHaveBeenCalledTimes(1)
    expect(onCreated).not.toHaveBeenCalled()

    resolveCreate?.(createdGroup)
    await flushPromises()

    expect(onCreated).toHaveBeenCalledTimes(1)
  })
})
