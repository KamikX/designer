import { describe, expect, it } from 'vitest'
import { assessExtraction } from './extract-quality'

/**
 * 这里守的是一条"沉默的失败":PDF 抽文字失败**不会报错**——扫描件返回空白,
 * 字体映射坏掉返回 (cid:N) 占位符。不主动判一次,模型就会拿着空白或乱码
 * 一本正经地往下推理,而且看起来一切正常。
 *
 * 误判的代价是不对称的:漏判(把乱码当好文字)会让模型胡说;误判(把好
 * 文字当乱码)只是多渲染几张图。所以判据宁可略松。
 */

const good = (text: string, pages = 1): boolean => assessExtraction(text, pages).usable

describe('正常文本要放行', () => {
  it('中文段落', () => {
    expect(good('设计需求说明。目标用户是一线运维工程师,主色希望偏冷静克制。')).toBe(true)
  })

  it('英文段落', () => {
    expect(good('The dashboard should surface alerts first, then trends.')).toBe(true)
  })

  it('中英混排 + 代码与十六进制色值', () => {
    expect(good('主色 #4f6ef7,次色 #8b93a7。字体 font-sans: ui-sans-serif。')).toBe(true)
  })

  it('markdown 表格(符号很多但仍是正常内容)', () => {
    const table = '| 指标 | 本月 | 环比 |\n| --- | --- | --- |\n| 活跃 | 12345 | 8.3% |'
    expect(good(table)).toBe(true)
  })

  it('多页文档只要总量够就放行', () => {
    expect(good('这是一份需求说明,包含若干页内容。'.repeat(10), 5)).toBe(true)
  })
})

describe('扫描件:抽不到文字', () => {
  it('完全空', () => {
    const verdict = assessExtraction('', 3)
    expect(verdict.usable).toBe(false)
    if (verdict.usable) return
    expect(verdict.kind).toBe('scanned')
    expect(verdict.reason).toContain('没有抽到任何文字')
  })

  it('只有页码分隔之类的残渣', () => {
    const verdict = assessExtraction('--- 第 1 页 ---', 1)
    expect(verdict.usable).toBe(false)
    if (verdict.usable) return
    expect(verdict.kind).toBe('scanned')
  })

  it('按页数折算:20 页只有一句话也算抽失败', () => {
    const verdict = assessExtraction('封面标题', 20)
    expect(verdict.usable).toBe(false)
    if (verdict.usable) return
    expect(verdict.kind).toBe('scanned')
    expect(verdict.reason).toContain('20 页')
  })
})

describe('乱码:抽到了但不能用', () => {
  it('cid 占位符', () => {
    const verdict = assessExtraction('(cid:12)(cid:5)(cid:88)(cid:3)(cid:44)(cid:9)'.repeat(3))
    expect(verdict.usable).toBe(false)
    if (verdict.usable) return
    expect(verdict.kind).toBe('garbled')
    expect(verdict.reason).toContain('cid')
  })

  it('大量替换字符', () => {
    const verdict = assessExtraction('这是正常的一段话'.repeat(3) + '�'.repeat(40))
    expect(verdict.usable).toBe(false)
    if (verdict.usable) return
    expect(verdict.kind).toBe('garbled')
  })

  it('几乎没有可识别文字', () => {
    const verdict = assessExtraction('«‡•∆◊ƒ©˙∂ß≈ç√∫˜µ≤≥÷ ‰ˇ¨ˆø π'.repeat(6))
    expect(verdict.usable).toBe(false)
    if (verdict.usable) return
    expect(verdict.kind).toBe('garbled')
  })

  it('少量 cid 不算——正文里偶尔出现不该一票否决', () => {
    expect(good(`正常内容${'很长的一段中文说明。'.repeat(10)}(cid:7)`)).toBe(true)
  })
})
