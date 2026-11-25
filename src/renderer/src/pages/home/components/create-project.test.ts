import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'
import {
  buildCreateProjectInput,
  createDefaultProjectForm,
  resetProjectForm,
  toggleProjectTarget,
  STYLE_BRIEF_FIELD_LABEL
} from './create-project'

describe('buildCreateProjectInput', () => {
  it('trims free text and preserves visual guidance fields', () => {
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

  it('drops stale component library selections for non-Vue projects', () => {
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
  it('restores all creation defaults in place', () => {
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
  it('exports the translation key for the optional visual style label', () => {
    expect(STYLE_BRIEF_FIELD_LABEL).toBe('common.visualStyle')
  })
})

describe('component target selection', () => {
  it('replaces page targets and allows deselection without selecting a default', () => {
    const form = createDefaultProjectForm()
    form.targets = ['web', 'mobile']
    toggleProjectTarget(form, 'components')
    expect(form.targets).toEqual(['components'])
    toggleProjectTarget(form, 'components')
    expect(form.targets).toEqual([])
  })

  it('replaces component development with a page target and preserves page multi-selection', () => {
    const form = createDefaultProjectForm()
    toggleProjectTarget(form, 'components')
    toggleProjectTarget(form, 'admin')
    toggleProjectTarget(form, 'mobile')
    expect(form.targets).toEqual(['admin', 'mobile'])
    toggleProjectTarget(form, 'admin')
    expect(form.targets).toEqual(['mobile'])
  })

  it.each(['html', 'vue3', 'react'] as const)(
    'submits components and resets to Web for %s',
    (stack) => {
      const form = reactive(createDefaultProjectForm())
      form.stack = stack
      toggleProjectTarget(form, 'components')
      const input = buildCreateProjectInput(form)
      expect(input.targets).toEqual(['components'])
      expect(input.stack).toBe(stack)
      expect(structuredClone(input)).toEqual(input)
      resetProjectForm(form)
      expect(form.targets).toEqual(['web'])
      expect(input.targets).toEqual(['components'])
    }
  )
})
