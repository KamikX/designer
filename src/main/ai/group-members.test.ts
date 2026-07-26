import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  GroupMember,
  GroupMemberDraft,
  GroupSendInput,
  InstalledSkill,
  Model,
  SessionSettings
} from '../../shared/types'
import { isConfiguredGroupMembers, normalizeGroupMembers } from '../../shared/group-members'
import { createGroupMembers, resolveGroupAgent } from './group-members'
import { roleTemplates } from './prompts/group-roles'

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: 'model-tools',
    providerId: 'provider-1',
    modelId: 'gpt-tools',
    displayName: 'Tools model',
    type: 'chat',
    abilities: ['tools'],
    contextWindow: 64_000,
    enabled: true,
    isBuiltin: false,
    sortOrder: 0,
    ...overrides
  }
}

function skill(name: string, source: InstalledSkill['source'] = 'app'): InstalledSkill {
  return {
    name,
    description: `${name} description`,
    source,
    dir: `/skills/${name}`
  }
}

function draft(overrides: Partial<GroupMemberDraft> = {}): GroupMemberDraft {
  return {
    name: '产品经理',
    color: '#e8662c',
    duty: '梳理需求',
    deliverable: '需求文档',
    persona: '你是产品经理。',
    modelRowId: 'model-tools',
    skillIds: [],
    ...overrides
  }
}

function create(
  drafts: GroupMemberDraft[],
  overrides: Partial<Parameters<typeof createGroupMembers>[1]> = {}
): GroupMember[] {
  let nextId = 0
  return createGroupMembers(drafts, {
    models: [model()],
    skills: [],
    createId: () => `member-${++nextId}`,
    ...overrides
  })
}

describe('createGroupMembers', () => {
  it('先 trim 名称，再生成不接受调用方指定 id 的持久成员', () => {
    const untrusted = { ...draft({ name: '  产品经理  ' }), id: 'caller-id' }

    expect(create([untrusted])).toEqual([
      {
        ...draft(),
        id: 'member-1'
      }
    ])
  })

  it('拒绝空成员和 trim 后为空的名称', () => {
    expect(() => create([])).toThrow(/至少.*成员/)
    expect(() => create([draft({ name: ' \t ' })])).toThrow(/名称/)
  })

  it.each([
    ['非数组', null],
    ['非对象成员', [null]],
    ['错误 color', [{ ...draft(), color: 123 }]],
    ['错误 duty', [{ ...draft(), duty: false }]],
    ['错误 deliverable', [{ ...draft(), deliverable: [] }]],
    ['错误 modelRowId', [{ ...draft(), modelRowId: 1 }]],
    ['错误 skillIds', [{ ...draft(), skillIds: ['research', 1] }]]
  ])('拒绝不可信输入中的%s', (_label, input) => {
    expect(() =>
      createGroupMembers(input as unknown as GroupMemberDraft[], {
        models: [model()],
        skills: [skill('research')],
        createId: () => 'member-1'
      })
    ).toThrow(/成员数据/)
  })

  it('拒绝空白人设', () => {
    expect(() => create([draft({ persona: '\n\t ' })])).toThrow(/人设/)
  })

  it('拒绝保留名称“用户”', () => {
    expect(() => create([draft({ name: ' 用户 ' })])).toThrow(/保留名称/)
  })

  it.each(['@设计师', '[设计师', '设计师]', '设计(师', '设计师)'])(
    '拒绝名称中的非法字符：%s',
    (name) => {
      expect(() => create([draft({ name })])).toThrow(/名称/)
    }
  )

  it.each([
    ['LF', '设计\n师'],
    ['CR', '设计\r师'],
    ['LINE SEPARATOR', '设计\u2028师'],
    ['PARAGRAPH SEPARATOR', '设计\u2029师']
  ])('拒绝名称中的 JS 行终止符：%s', (_label, name) => {
    expect(() => create([draft({ name })])).toThrow(/名称/)
  })

  it('拒绝超过 24 个字符的名称', () => {
    expect(() => create([draft({ name: '一'.repeat(25) })])).toThrow(/24/)
  })

  it('按 trim 后的名称检查群内重复', () => {
    expect(() => create([draft({ name: '产品经理' }), draft({ name: ' 产品经理 ' })])).toThrow(
      /重复/
    )
  })

  it.each([
    ['不存在', 'missing', [model()]],
    ['已停用', 'disabled', [model({ id: 'disabled', enabled: false })]],
    ['不是对话模型', 'image', [model({ id: 'image', type: 'image' })]],
    ['不支持 tools', 'without-tools', [model({ id: 'without-tools', abilities: [] })]]
  ])('拒绝%s的模型', (_label, modelRowId, models) => {
    expect(() => create([draft({ modelRowId })], { models })).toThrow(/模型/)
  })

  it('只保存当前存在且非 builtin 的技能名称，并去重', () => {
    const members = create(
      [
        draft({
          skillIds: ['research', 'builtin-craft', 'missing', 'research']
        })
      ],
      {
        skills: [skill('research'), skill('builtin-craft', 'builtin')]
      }
    )

    expect(members[0].skillIds).toEqual(['research'])
  })

  it('createId 碰撞时继续生成，保证群内 id 唯一', () => {
    const ids = ['same', 'same', 'unique']
    const members = create([draft(), draft({ name: 'UI设计师' })], {
      createId: () => ids.shift() ?? 'unused'
    })

    expect(members.map((member) => member.id)).toEqual(['same', 'unique'])
  })
})

describe('normalizeGroupMembers', () => {
  it('只返回完整合法的 GroupMember[]', () => {
    const member: GroupMember = { ...draft(), id: 'member-1' }
    const settings: SessionSettings = { members: [member] }

    expect(isConfiguredGroupMembers(settings.members)).toBe(true)
    expect(normalizeGroupMembers(settings.members)).toEqual([member])
  })

  it.each([
    ['缺失', undefined],
    ['旧 string[]', ['pm', 'ui']],
    ['字段缺失的对象数组', [{ id: 'member-1', name: '产品经理' }]],
    ['混合数组', [{ ...draft(), id: 'member-1' }, 'pm']]
  ])('%s不被识别为 configured，也不生成展示成员', (_label, members) => {
    const untrusted = members as unknown

    expect(isConfiguredGroupMembers(untrusted)).toBe(false)
    expect(normalizeGroupMembers(untrusted)).toEqual([])
  })
})

describe('resolveGroupAgent', () => {
  it('成员使用自己的模型行与技能', () => {
    const member: GroupMember = {
      ...draft({ modelRowId: 'member-model', skillIds: ['research', 'writing'] }),
      id: 'member-1'
    }
    const selectedModel = model({
      id: 'member-model',
      providerId: 'provider-member',
      modelId: 'provider-model'
    })

    expect(
      resolveGroupAgent(member, (id) => (id === selectedModel.id ? selectedModel : null))
    ).toEqual({
      id: 'member-1',
      name: '产品经理',
      color: '#e8662c',
      duty: '梳理需求',
      deliverable: '需求文档',
      persona: '你是产品经理。',
      model: selectedModel,
      skillIds: ['research', 'writing']
    })
  })

  it.each([
    ['不存在', null],
    ['已停用', model({ id: 'bad-model', enabled: false })],
    ['不是对话模型', model({ id: 'bad-model', type: 'image' })],
    ['不支持 tools', model({ id: 'bad-model', abilities: [] })]
  ])('configured 成员模型%s时给出带成员名的中文错误', (label, selectedModel) => {
    const member: GroupMember = {
      ...draft({ name: '研究员', modelRowId: 'bad-model' }),
      id: 'member-1'
    }

    expect(() => resolveGroupAgent(member, () => selectedModel)).toThrow(
      new RegExp(`研究员.*${label}`)
    )
  })
})

describe('群组发送契约', () => {
  it('只包含会话和文本，不再暴露公共 fallback 模型', () => {
    expectTypeOf<GroupSendInput>().toEqualTypeOf<{
      conversationId: string
      text: string
    }>()
  })
})

describe('内置角色 DTO', () => {
  it('可编辑模板包含 persona 但不携带模型和技能', () => {
    const template = roleTemplates()[0]

    expect(template.persona).toContain('产品经理')
    expect(template).not.toHaveProperty('modelRowId')
    expect(template).not.toHaveProperty('skillIds')
  })
})
