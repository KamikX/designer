import { describe, expect, it } from 'vitest'
import { buildCreateProjectInput } from './create-project'

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
