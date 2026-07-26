import { describe, expect, it } from 'vitest'
import type { GroupMemberTemplate } from '@shared/types'
import {
  createBlankMemberDraft,
  createMemberDraftFromTemplate,
  moveMemberDraft,
  removeMemberDraft,
  toGroupMemberDrafts,
  validateMemberDrafts
} from './member-drafts'

const template: GroupMemberTemplate = {
  id: 'pm',
  name: '产品经理',
  color: '#e8662c',
  duty: '梳理需求',
  deliverable: '需求文档',
  persona: '你是产品经理'
}

describe('成员草稿', () => {
  it('从模板复制可编辑字段但不继承模板 id 和模型', () => {
    const draft = createMemberDraftFromTemplate(template, () => 'temp-1')

    expect(draft).toEqual({
      tempKey: 'temp-1',
      name: '产品经理',
      color: '#e8662c',
      duty: '梳理需求',
      deliverable: '需求文档',
      persona: '你是产品经理',
      modelRowId: '',
      skillIds: []
    })
  })

  it('模板带预勾选技能时草稿带入,且与模板不共享数组', () => {
    const withSkills: GroupMemberTemplate = {
      ...template,
      skillIds: ['create-prd', 'user-stories']
    }
    const draft = createMemberDraftFromTemplate(withSkills, () => 'temp-2')

    expect(draft.skillIds).toEqual(['create-prd', 'user-stories'])
    draft.skillIds.push('别的')
    // 草稿改动不许污染模板常量
    expect(withSkills.skillIds).toEqual(['create-prd', 'user-stories'])
  })

  it('创建可从零配置的空白成员并生成 UI 临时 key', () => {
    const draft = createBlankMemberDraft(() => 'temp-blank')

    expect(draft.tempKey).toBe('temp-blank')
    expect(draft.name).toBe('')
    expect(draft.persona).toBe('')
    expect(draft.modelRowId).toBe('')
    expect(draft.skillIds).toEqual([])
  })

  it('按临时 key 删除成员且不改动原数组', () => {
    const first = createMemberDraftFromTemplate(template, () => 'first')
    const second = createBlankMemberDraft(() => 'second')
    const members = [first, second]

    expect(removeMemberDraft(members, 'first')).toEqual([second])
    expect(members).toEqual([first, second])
  })

  it('上下移动成员并在边界保持原顺序', () => {
    const first = createBlankMemberDraft(() => 'first')
    const second = createBlankMemberDraft(() => 'second')
    const third = createBlankMemberDraft(() => 'third')
    const members = [first, second, third]

    expect(moveMemberDraft(members, 'second', 'up').map((member) => member.tempKey)).toEqual([
      'second',
      'first',
      'third'
    ])
    expect(moveMemberDraft(members, 'third', 'down')).toEqual(members)
    expect(members.map((member) => member.tempKey)).toEqual(['first', 'second', 'third'])
  })

  it('校验成员名称、人设、唯一性和当前有效模型', () => {
    const base = {
      ...createBlankMemberDraft(() => 'first'),
      name: ' 策划 ',
      persona: '负责策划',
      modelRowId: 'model-1'
    }

    expect(validateMemberDrafts([base], new Set(['model-1']))).toBeNull()
    expect(validateMemberDrafts([{ ...base, name: '用户' }], new Set(['model-1']))).toBe(
      '成员名称不能使用“用户”'
    )
    expect(validateMemberDrafts([{ ...base, name: '产品@经理' }], new Set(['model-1']))).toBe(
      '成员名称不能包含 @、[、]、(、) 或换行'
    )
    expect(
      validateMemberDrafts(
        [base, { ...base, tempKey: 'second', name: '策划' }],
        new Set(['model-1'])
      )
    ).toBe('成员名称不能重复')
    expect(validateMemberDrafts([{ ...base, modelRowId: '' }], new Set(['model-1']))).toBe(
      '请为“策划”选择支持工具调用的模型'
    )
    expect(validateMemberDrafts([{ ...base, persona: '  ' }], new Set(['model-1']))).toBe(
      '请填写“策划”的人设'
    )
  })

  it('提交前去掉临时 key、trim 文本并摊平技能数组', () => {
    const draft = {
      ...createBlankMemberDraft(() => 'temp-only'),
      name: ' 策划 ',
      duty: ' 需求拆解 ',
      deliverable: ' 需求文档 ',
      persona: ' 负责策划 ',
      modelRowId: 'model-1',
      skillIds: ['app-skill', 'agents-skill']
    }

    const [plain] = toGroupMemberDrafts([draft])

    expect(plain).toEqual({
      name: '策划',
      color: draft.color,
      duty: '需求拆解',
      deliverable: '需求文档',
      persona: '负责策划',
      modelRowId: 'model-1',
      skillIds: ['app-skill', 'agents-skill']
    })
    expect(plain).not.toHaveProperty('tempKey')
    expect(plain.skillIds).not.toBe(draft.skillIds)
  })
})
