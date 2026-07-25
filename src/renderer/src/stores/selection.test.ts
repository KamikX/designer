import { describe, expect, it } from 'vitest'
import { isChoiceAlive, reconcileNames, restoreModelChoice } from './selection'

/**
 * 这些规则错了不会当场报错,要等到"重启之后"才看得见——正是最该有测试的
 * 那一类。
 */

const skills = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]

describe('reconcileNames', () => {
  it('没选过(null)→ 空数组。默认零勾选,没有"按全局启用兜底"', () => {
    expect(reconcileNames(null, skills)).toEqual([])
  })

  it('空数组保持为空', () => {
    expect(reconcileNames([], skills)).toEqual([])
  })

  it('保留用户勾选的名字', () => {
    expect(reconcileNames(['b'], skills)).toEqual(['b'])
  })

  it('剔掉已经不存在的名字', () => {
    expect(reconcileNames(['a', '已删除', 'c'], skills)).toEqual(['a', 'c'])
  })

  it('全被删光后仍是空数组', () => {
    expect(reconcileNames(['已删除'], skills)).toEqual([])
  })
})

describe('restoreModelChoice', () => {
  it('两个字段齐全才恢复', () => {
    expect(restoreModelChoice({ providerId: 'p1', modelId: 'm1' })).toEqual({
      providerId: 'p1',
      modelId: 'm1'
    })
  })

  it('只存了一半 → 当没选过', () => {
    expect(restoreModelChoice({ providerId: 'p1' })).toBeNull()
    expect(restoreModelChoice({ modelId: 'm1' })).toBeNull()
  })

  it('没有存档 → null', () => {
    expect(restoreModelChoice(null)).toBeNull()
    expect(restoreModelChoice({})).toBeNull()
  })

  it('只带技能的存档不会凭空造出模型选择', () => {
    expect(restoreModelChoice({ skillIds: ['a'] })).toBeNull()
  })
})

describe('isChoiceAlive', () => {
  const groups = [
    { provider: { id: 'p1' }, models: [{ id: 'm1' }, { id: 'm2' }] },
    { provider: { id: 'p2' }, models: [{ id: 'm3' }] }
  ]

  it('还在就是活的', () => {
    expect(isChoiceAlive({ providerId: 'p1', modelId: 'm2' }, groups)).toBe(true)
  })

  it('模型被停用/删除 → 不活', () => {
    expect(isChoiceAlive({ providerId: 'p1', modelId: '没了' }, groups)).toBe(false)
  })

  it('供应商没了 → 不活', () => {
    expect(isChoiceAlive({ providerId: '没了', modelId: 'm1' }, groups)).toBe(false)
  })

  it('模型 id 对但挂在别的供应商下 → 不活', () => {
    // 只比 modelId 会误判成活的,然后带着错的 providerId 发出去
    expect(isChoiceAlive({ providerId: 'p2', modelId: 'm1' }, groups)).toBe(false)
  })

  it('没选过 → 不活(交给兜底去选第一个)', () => {
    expect(isChoiceAlive(null, groups)).toBe(false)
  })

  it('列表为空时一律不活——调用方必须自己先挡住"还没加载完"', () => {
    expect(isChoiceAlive({ providerId: 'p1', modelId: 'm1' }, [])).toBe(false)
  })
})
