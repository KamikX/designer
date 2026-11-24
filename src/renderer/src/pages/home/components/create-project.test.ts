import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  buildCreateProjectInput,
  createDefaultProjectForm,
  resetProjectForm,
  STYLE_BRIEF_FIELD_LABEL
} from './create-project'

describe('buildCreateProjectInput', () => {
  it('清理自由文本两端空白并保留视觉方向字段', () => {
    expect(
      buildCreateProjectInput({
        name: '  运营后台  ',
        stack: 'vue3',
        designMode: 'design',
        targets: ['admin'],
        libs: ['antdv-next'],
        externalLibraries: [],
        description: '  管理订单  ',
        styleBrief: '  深色工业感，高密度，直角卡片  ',
        designDocument: '',
        visualStylePriority: 'styleBrief'
      })
    ).toEqual({
      name: '运营后台',
      stack: 'vue3',
      designMode: 'design',
      targets: ['admin'],
      libs: ['antdv-next'],
      externalLibraries: [],
      description: '管理订单',
      styleBrief: '深色工业感，高密度，直角卡片',
      designDocument: '',
      visualStylePriority: 'styleBrief'
    })
  })

  it('非 Vue 项目不会提交残留的组件库选择', () => {
    expect(
      buildCreateProjectInput({
        name: '原型',
        stack: 'html',
        designMode: 'prototype',
        targets: [],
        libs: ['antdv-next'],
        externalLibraries: [],
        description: '',
        styleBrief: '   ',
        designDocument: '',
        visualStylePriority: 'styleBrief'
      })
    ).toMatchObject({ libs: [], styleBrief: '' })
  })
})

it('creates a cloneable IPC payload from reactive external library selections', () => {
  const form = reactive(createDefaultProjectForm())
  form.stack = 'react'
  form.externalLibraries = [{ name: 'zod', version: '4.4.3' }]
  const input = buildCreateProjectInput(form)
  expect(structuredClone(input)).toEqual(input)
})

describe('resetProjectForm', () => {
  it('原位恢复所有创建默认值', () => {
    const form = createDefaultProjectForm()
    form.name = '后台'
    form.stack = 'react'
    form.designMode = 'prototype'
    form.targets = ['admin']
    form.libs = ['antdv-next']
    form.description = '订单管理'
    form.styleBrief = '深色工业风'
    form.designDocument = '# Brand'
    form.visualStylePriority = 'designDocument'
    const original = form

    resetProjectForm(form)

    expect(form).toBe(original)
    expect(form).toEqual({
      name: '',
      stack: 'html',
      designMode: 'design',
      // 默认勾 web:targets 为空时端契约与端模板零注入,见 create-project.ts
      targets: ['web'],
      libs: [],
      externalLibraries: [],
      description: '',
      styleBrief: '',
      designDocument: '',
      visualStylePriority: 'styleBrief'
    })
  })
})

describe('CreateProjectModal', () => {
  it('明确标注视觉风格可以留空', () => {
    expect(STYLE_BRIEF_FIELD_LABEL).toBe('视觉风格（可选）')
  })
})
