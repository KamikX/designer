import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildCreateProjectInput,
  createDefaultProjectForm,
  resetProjectForm
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
        description: '  管理订单  ',
        styleBrief: '  深色工业感，高密度，直角卡片  '
      })
    ).toEqual({
      name: '运营后台',
      stack: 'vue3',
      designMode: 'design',
      targets: ['admin'],
      libs: ['antdv-next'],
      description: '管理订单',
      styleBrief: '深色工业感，高密度，直角卡片'
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
        description: '',
        styleBrief: '   '
      })
    ).toMatchObject({ libs: [], styleBrief: '' })
  })
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
    const original = form

    resetProjectForm(form)

    expect(form).toBe(original)
    expect(form).toEqual({
      name: '',
      stack: 'html',
      designMode: 'design',
      targets: [],
      libs: [],
      description: '',
      styleBrief: ''
    })
  })
})

describe('CreateProjectModal', () => {
  it('明确标注视觉风格可以留空', () => {
    const source = readFileSync(join(__dirname, 'CreateProjectModal.vue'), 'utf8')

    expect(source).toContain('label="视觉风格（可选）"')
  })
})
