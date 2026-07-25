import { describe, expect, it } from 'vitest'
import { MAX_FILES_AT_ONCE } from '@shared/limits'
import { composeMessageBody, planAttachment } from './attach'

describe('planAttachment', () => {
  it('空着的时候能收满上限', () => {
    expect(planAttachment(0, MAX_FILES_AT_ONCE)).toEqual({
      accept: MAX_FILES_AT_ONCE,
      overflow: false
    })
  })

  it('恰好放满不算超——边界不该误报', () => {
    expect(planAttachment(MAX_FILES_AT_ONCE - 3, 3)).toEqual({ accept: 3, overflow: false })
  })

  it('超出的部分截掉,并标记要提示用户改用目录授权', () => {
    expect(planAttachment(MAX_FILES_AT_ONCE - 2, 5)).toEqual({ accept: 2, overflow: true })
  })

  it('已经满了就一个都不收', () => {
    expect(planAttachment(MAX_FILES_AT_ONCE, 1)).toEqual({ accept: 0, overflow: true })
  })

  it('超满(比如别处已经多塞了)也不会算出负数名额', () => {
    // accept 为负会让 slice(0, -1) 悄悄丢掉最后一个文件
    expect(planAttachment(MAX_FILES_AT_ONCE + 5, 2)).toEqual({ accept: 0, overflow: true })
  })

  it('一次拖 100 个,只收上限那么多', () => {
    expect(planAttachment(0, 100)).toEqual({ accept: MAX_FILES_AT_ONCE, overflow: true })
  })
})

describe('composeMessageBody', () => {
  it('没有文件时原样返回,不留多余空行', () => {
    expect(composeMessageBody('做个后台首页', [])).toBe('做个后台首页')
  })

  it('把路径逐条列出来,并点名用哪个工具读', () => {
    const out = composeMessageBody('参考这个', ['/a/需求.pdf', '/b/App.vue'])
    expect(out).toContain('/a/需求.pdf')
    expect(out).toContain('/b/App.vue')
    expect(out).toContain('read_local_document')
  })

  it('只拖文件不打字也能成立——正文不该以空行开头', () => {
    const out = composeMessageBody('', ['/a/需求.pdf'])
    expect(out.startsWith('附带文件')).toBe(true)
  })

  it('原文保留在最前面,用户说的话不被文件清单淹掉', () => {
    expect(composeMessageBody('照着这个做', ['/a/x.ts']).split('\n')[0]).toBe('照着这个做')
  })
})
