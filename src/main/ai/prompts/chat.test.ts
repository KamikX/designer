import { describe, expect, it } from 'vitest'
import { buildChatPrompt } from './chat'

/**
 * 纯聊天提示词的核心约定是**默认什么都不说**。
 *
 * 这条很容易在后续迭代里被悄悄破坏:某天有人觉得"加一句身份说明也无妨",
 * 聊天就不再是干净的了。用户来这个页面就是要一个没有人设的模型,所以这里
 * 把"空"当成一个正经的、要被测试保护的行为。
 *
 * 技能不再有"全文注入"——勾选的技能只以目录(渐进披露 L1)形式出现,
 * 没勾就连目录都没有。
 */

describe('默认什么都不说', () => {
  it('没有任何开关时返回空串', () => {
    expect(buildChatPrompt()).toBe('')
    expect(buildChatPrompt({})).toBe('')
  })

  it('空目录不算开关', () => {
    expect(buildChatPrompt({ skillCatalog: '' })).toBe('')
  })

  it('联网关着时不提搜索', () => {
    expect(buildChatPrompt({ webSearch: false })).toBe('')
  })

  it('空白的 localScope 不占位置', () => {
    expect(buildChatPrompt({ localScope: '   \n  ' })).toBe('')
  })
})

describe('只说用户开了的那件事', () => {
  it('开了联网才有联网那段', () => {
    const out = buildChatPrompt({ webSearch: true })
    expect(out).toContain('web_search')
    expect(out).toContain('web_fetch')
  })

  it('联网段要求先搜再读——抓取比搜索贵得多', () => {
    expect(buildChatPrompt({ webSearch: true })).toContain('先搜再读')
  })

  it('联网段禁止用记忆填补搜索的空白', () => {
    // 这是最危险的失败模式:用户以为看到的是刚查到的,其实是编的
    expect(buildChatPrompt({ webSearch: true })).toContain('不要用记忆填补')
  })

  it('授权了目录才有本地范围那段', () => {
    const out = buildChatPrompt({ localScope: '## 可访问的本地范围\n- 项目 → /tmp/x' })
    expect(out).toContain('/tmp/x')
  })

  it('勾选了技能才有目录那段', () => {
    const out = buildChatPrompt({
      skillCatalog: '<available_skills>\n我的规范\n</available_skills>'
    })
    expect(out).toContain('我的规范')
  })

  it('多个开关各自成段,互不吞并', () => {
    const out = buildChatPrompt({ localScope: '## 本地\n- a → /tmp/a', webSearch: true })
    expect(out).toContain('/tmp/a')
    expect(out).toContain('web_search')
  })
})
