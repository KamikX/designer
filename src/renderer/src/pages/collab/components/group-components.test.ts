// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, h, shallowRef } from 'vue'
import { Mentions, Modal, Select, Tag } from 'antdv-next'
import { useCollabStore } from '@renderer/stores/collab'
import { useProviderStore } from '@renderer/stores/provider'
import type {
  Conversation,
  CreateGroupInput,
  DesignerApi,
  GroupMember,
  GroupMemberTemplate,
  InstalledSkill,
  Message,
  Model,
  Provider
} from '@shared/types'
import type { MemberDraft } from '../member-drafts'
import GroupMemberEditor from './GroupMemberEditor.vue'
import GroupMemberList from './GroupMemberList.vue'
import CreateGroupModal from './CreateGroupModal.vue'
import GroupComposer from './GroupComposer.vue'
import GroupMarkdownStream from './GroupMarkdownStream.vue'
import GroupMentionText from './GroupMentionText.vue'
import GroupMessage from './GroupMessage.vue'
import CollabPage from '../index.vue'

const appMessage = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  success: vi.fn()
}))
const modalConfirm = vi.hoisted(() => vi.fn())

vi.mock('antdv-next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('antdv-next')>()
  return {
    ...actual,
    App: Object.assign({}, actual.App, {
      useApp: () => ({ message: appMessage, modal: { confirm: modalConfirm } })
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

const MEMBER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const configuredMember: GroupMember = {
  id: MEMBER_ID,
  name: '产品经理',
  color: '#e8662c',
  duty: '梳理需求',
  deliverable: '需求文档',
  persona: '你是产品经理',
  modelRowId: toolsModel.id,
  skillIds: []
}

function groupWithMembers(members: GroupMember[]): Conversation {
  return {
    ...createdGroup,
    settings: { members }
  }
}

function textMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    conversationId: createdGroup.id,
    role: 'user',
    parts: [{ type: 'text', text: '请 @产品经理 开始' }],
    status: 'complete',
    usage: null,
    providerSlug: null,
    modelId: null,
    artifactId: null,
    author: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
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
        create: createGroup,
        roles: vi.fn(async () => [template]),
        list: vi.fn(async () => [createdGroup]),
        messages: vi.fn(async () => []),
        onStream: vi.fn(() => () => undefined),
        send: vi.fn(async () => undefined)
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
  modalConfirm.mockClear()
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

describe('GroupComposer', () => {
  it('输入和纯图标操作都有可访问名称，始终没有公共模型选择器', async () => {
    const pinia = prepareStores()
    const collab = useCollabStore()
    collab.groups = [groupWithMembers([configuredMember])]
    collab.conversationId = createdGroup.id

    const wrapper = mount(GroupComposer, {
      attachTo: document.body,
      global: { plugins: [pinia] }
    })

    expect(wrapper.get('textarea').attributes('aria-label')).toBe('群组消息')
    expect(wrapper.findComponent(Select).exists()).toBe(false)
    expect(wrapper.get('.gcomposer-send').attributes('aria-label')).toBe('发送群组消息')

    collab.chaining[createdGroup.id] = true
    await nextTick()

    expect(wrapper.get('.gcomposer-send').attributes('aria-label')).toBe('暂停群组接力')
  })

  it('新群候选选择写入规范提及，且不显示公共模型选择器', async () => {
    const pinia = prepareStores()
    const collab = useCollabStore()
    const send = vi.fn(async () => undefined)
    window.api.group.send = send
    collab.groups = [groupWithMembers([configuredMember])]
    collab.conversationId = createdGroup.id

    const wrapper = mount(GroupComposer, {
      attachTo: document.body,
      global: { plugins: [pinia] }
    })
    const mentions = wrapper.getComponent(Mentions)
    const option = mentions.props('options')?.[0]

    expect(option).toMatchObject({
      label: configuredMember.name,
      value: `[${configuredMember.name}](member:${MEMBER_ID})`
    })
    const textarea = wrapper.get('textarea')
    await textarea.setValue('@')
    await textarea.trigger('keyup', { key: '@', keyCode: 50, which: 50 })
    await textarea.trigger('keydown', { key: 'Enter', keyCode: 13, which: 13 })
    await flushPromises()

    expect(mentions.props('value')).toBe(`@[${configuredMember.name}](member:${MEMBER_ID}) `)
    expect(send).not.toHaveBeenCalled()
    expect(wrapper.findComponent(Select).exists()).toBe(false)
  })

  it('运行时损坏的 string[] 不生成候选，也不恢复公共模型选择器', () => {
    const pinia = prepareStores()
    const collab = useCollabStore()
    collab.groups = [
      {
        ...createdGroup,
        settings: { members: [template.id] }
      } as unknown as Conversation
    ]
    collab.conversationId = createdGroup.id

    const wrapper = mount(GroupComposer, {
      attachTo: document.body,
      global: { plugins: [pinia] }
    })
    const mentions = wrapper.getComponent(Mentions)

    expect(mentions.props('options')).toEqual([])
    expect(wrapper.findComponent(Select).exists()).toBe(false)
  })

  it.each([
    ['Shift+Enter', { shiftKey: true, isComposing: false }],
    ['输入法 Enter', { shiftKey: false, isComposing: true }]
  ])('%s 不选择候选且保留 textarea 默认行为', async (_, keyboard) => {
    const pinia = prepareStores()
    const collab = useCollabStore()
    const send = vi.fn(async () => undefined)
    window.api.group.send = send
    collab.groups = [groupWithMembers([configuredMember])]
    collab.conversationId = createdGroup.id

    const wrapper = mount(GroupComposer, {
      attachTo: document.body,
      global: { plugins: [pinia] }
    })
    const textarea = wrapper.get('textarea')
    await textarea.setValue('@')
    await textarea.trigger('keyup', { key: '@', keyCode: 50, which: 50 })

    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      shiftKey: keyboard.shiftKey,
      isComposing: keyboard.isComposing,
      bubbles: true,
      cancelable: true
    })
    Object.defineProperty(event, 'which', { value: 13 })
    textarea.element.dispatchEvent(event)
    await flushPromises()

    expect(event.defaultPrevented).toBe(false)
    expect(wrapper.getComponent(Mentions).props('value')).toBe('@')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('CollabPage group navigation', () => {
  it('用同级按钮呈现打开和删除操作，并支持 Enter 打开群组', async () => {
    const pinia = prepareStores()
    const wrapper = mount(CollabPage, {
      attachTo: document.body,
      global: {
        plugins: [pinia],
        stubs: {
          MemberBar: true,
          GroupMessage: true,
          GroupComposer: true,
          CreateGroupModal: true
        }
      }
    })
    await flushPromises()

    const row = wrapper.get('.collab-item')
    const buttons = row.findAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0].text()).toContain(createdGroup.title)
    expect(buttons[1].attributes('aria-label')).toBe(`删除群组 ${createdGroup.title}`)

    await buttons[0].trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(useCollabStore().conversationId).toBe(createdGroup.id)
    expect(window.api.group.messages).toHaveBeenCalledWith(createdGroup.id)
  })
})

describe('GroupMentionText', () => {
  it('高亮新旧有效提及，代码区与未知 ID 保持普通文本', () => {
    const unknownId = '01BX5ZZKBKACTAV9WEVGEMMVRZ'
    const content = [
      `@[${configuredMember.name}](member:${MEMBER_ID}) 和 @${configuredMember.name}`,
      `\`@${configuredMember.name}\``,
      `@[陌生人](member:${unknownId})`
    ].join('\n')
    const wrapper = mount(GroupMentionText, {
      props: { content, members: [configuredMember] }
    })

    expect(wrapper.findAllComponents(Tag)).toHaveLength(2)
    expect(wrapper.text()).toContain(`@${configuredMember.name}`)
    expect(wrapper.text()).toContain(`\`@${configuredMember.name}\``)
    expect(wrapper.text()).toContain(`@[陌生人](member:${unknownId})`)
  })
})

describe('GroupMarkdownStream', () => {
  it('通过实际组件映射把有效提及渲染为 tag，并保留普通安全链接', async () => {
    const wrapper = mount(GroupMarkdownStream, {
      props: {
        content: `@${configuredMember.name} [官网](https://example.com)`,
        members: [configuredMember]
      }
    })
    await flushPromises()

    expect(wrapper.findAllComponents(Tag)).toHaveLength(1)
    expect(wrapper.get('a[href="https://example.com/"]').text()).toBe('官网')
  })

  it('成员名含 Markdown 标点时仍渲染为单一 tag', async () => {
    const member = { ...configuredMember, name: '研究**员**_&copy;' }
    const wrapper = mount(GroupMarkdownStream, {
      props: {
        content: `@${member.name}`,
        members: [member]
      }
    })
    await flushPromises()

    expect(wrapper.findAllComponents(Tag)).toHaveLength(1)
    expect(wrapper.getComponent(Tag).text()).toBe(`@${member.name}`)
  })

  it('拒绝协议相对链接，并规范化外部协议后统一隔离打开', async () => {
    const wrapper = mount(GroupMarkdownStream, {
      props: {
        content: [
          '[协议相对](//evil.example)',
          '[根路径](/local)',
          '[当前目录](./local)',
          '[上级目录](../local)',
          '[页内](#section)',
          '[大小写](HTTP://evil.example)',
          '[无斜线](http:evil.example)'
        ].join(' '),
        members: [configuredMember]
      }
    })
    await flushPromises()

    expect(wrapper.find('a[href="//evil.example"]').exists()).toBe(false)
    for (const label of ['协议相对', '根路径', '当前目录', '上级目录']) {
      expect(wrapper.findAll('a').some((item) => item.text() === label)).toBe(false)
    }
    expect(wrapper.get('a[href="#section"]').attributes('target')).toBeUndefined()
    for (const label of ['大小写', '无斜线']) {
      const link = wrapper.findAll('a').find((item) => item.text() === label)
      expect(link?.attributes()).toMatchObject({
        href: 'http://evil.example/',
        target: '_blank',
        rel: 'noopener noreferrer'
      })
    }
  })

  it('有效成员 ID 搭配错误或嵌套 label 时不伪装成 tag', async () => {
    const wrapper = mount(GroupMarkdownStream, {
      props: {
        content: [
          `[伪造](group-member:${MEMBER_ID})`,
          `[@产品**经理**](group-member:${MEMBER_ID})`,
          `[](group-member:${MEMBER_ID})`
        ].join('\n\n'),
        members: [configuredMember]
      }
    })
    await flushPromises()

    expect(wrapper.findComponent(Tag).exists()).toBe(false)
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).toContain('伪造')
    expect(wrapper.text()).toContain('@产品经理')
  })

  it('代码区、未知内部链接和流式半截提及不渲染 tag', async () => {
    const wrapper = mount(GroupMarkdownStream, {
      props: {
        content: [
          `\`@${configuredMember.name}\``,
          '[伪造](group-member:01BX5ZZKBKACTAV9WEVGEMMVRZ)',
          `@[${configuredMember.name}](member:${MEMBER_ID}`
        ].join('\n\n'),
        members: [configuredMember],
        streaming: true
      }
    })
    await flushPromises()

    expect(wrapper.findComponent(Tag).exists()).toBe(false)
    expect(wrapper.text()).toContain(`@${configuredMember.name}`)
    expect(wrapper.text()).toContain('伪造')
  })
})

describe('GroupMessage', () => {
  it('用户消息接入 GroupMentionText，Agent 消息接入 GroupMarkdownStream', () => {
    const pinia = prepareStores()
    const collab = useCollabStore()
    collab.groups = [groupWithMembers([configuredMember])]
    collab.conversationId = createdGroup.id

    const user = mount(GroupMessage, {
      props: { message: textMessage() },
      global: { plugins: [pinia] }
    })
    const agent = mount(GroupMessage, {
      props: {
        message: textMessage({
          role: 'assistant',
          author: MEMBER_ID,
          parts: [{ type: 'text', text: `请 @${configuredMember.name} 复核` }]
        })
      },
      global: { plugins: [pinia] }
    })

    expect(user.findComponent(GroupMentionText).exists()).toBe(true)
    expect(agent.findComponent(GroupMarkdownStream).exists()).toBe(true)
  })
})

describe('collab store mentions and stop state', () => {
  it('只暴露已配置成员，发送 payload 不含 fallback 模型', async () => {
    prepareStores()
    const collab = useCollabStore()
    const send = vi.fn(async () => undefined)
    window.api.group.send = send

    collab.groups = [groupWithMembers([configuredMember])]
    collab.conversationId = createdGroup.id
    expect(collab.mentionMembers).toEqual([configuredMember])
    await collab.send(`@${configuredMember.name}`)
    expect(send).toHaveBeenLastCalledWith({
      conversationId: createdGroup.id,
      text: `@${configuredMember.name}`
    })
    expect(collab).not.toHaveProperty('model')
    expect(collab).not.toHaveProperty('selectModel')
  })

  it('运行时 string[] 不生成成员', () => {
    prepareStores()
    const collab = useCollabStore()
    collab.groups = [
      {
        ...createdGroup,
        settings: { members: [template.id] }
      } as unknown as Conversation
    ]
    collab.conversationId = createdGroup.id

    expect(collab.memberRoles).toEqual([])
    expect(collab.mentionMembers).toEqual([])
  })

  it('chain-stopped 清理当前与后台群运行态，并展示当前群中文原因', () => {
    prepareStores()
    const collab = useCollabStore()
    collab.groups = [groupWithMembers([configuredMember])]
    collab.conversationId = createdGroup.id
    collab.chaining = { [createdGroup.id]: true, background: true }
    collab.speakingAuthor = MEMBER_ID

    collab.handleEvent({
      type: 'chain-stopped',
      conversationId: createdGroup.id,
      reason: 'cycle-detected',
      message: '检测到重复接力，已停止'
    })

    expect(collab.chaining[createdGroup.id]).toBeUndefined()
    expect(collab.speakingAuthor).toBe('')
    expect(collab.error).toBe('检测到重复接力，已停止')

    collab.handleEvent({
      type: 'chain-stopped',
      conversationId: 'background',
      reason: 'hop-limit',
      message: '接力次数已达上限'
    })
    expect(collab.chaining.background).toBeUndefined()
  })
})
