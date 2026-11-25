import { tool } from 'ai'
import { z } from 'zod'
import { nextMentions } from '../shared/group-mentions'
import { buildBootstrapHtml } from './preview/bootstrap'
import { buildChatPrompt } from './ai/prompts/chat'
import { afterEach, describe, expect, it } from 'vitest'
import { bindMainLanguage, currentLanguage, localizedTools, text, withLanguage } from './i18n'
import { buildFileTools } from './ai/tools'
import { SessionVfs } from './ai/session-vfs'
import { buildTimeTools } from './ai/time-tools'
import { roleTemplates } from './ai/prompts/group-roles'

const han = /\p{Script=Han}/u
const options = { toolCallId: 'localization-test', messages: [] } as never

afterEach(() => bindMainLanguage(() => 'zh-CN'))

describe('main-process translation contexts', () => {
  it('uses the application language outside a conversation and restores nested scopes', () => {
    bindMainLanguage(() => 'en-US')
    expect(text('common.save')).toBe('Save')
    withLanguage('zh-CN', () => {
      expect(text('common.save')).toBe('保存')
      expect(withLanguage('en-US', () => text('common.save'))).toBe('Save')
      expect(currentLanguage()).toBe('zh-CN')
    })
    expect(text('common.save')).toBe('Save')
  })

  it('keeps concurrent tool languages isolated across asynchronous calls', async () => {
    let release: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      release = resolve
    })
    const english = localizedTools(
      {
        wait: tool({
          inputSchema: z.object({}),
          execute: async () => {
            await ready
            return text('common.save')
          }
        })
      },
      'en-US'
    )
    const pending = english.wait.execute!({} as never, options)
    expect(withLanguage('zh-CN', () => text('common.save'))).toBe('保存')
    release()
    expect(await pending).toBe('Save')
    expect(currentLanguage()).toBe('zh-CN')
  })

  it('localizes VFS errors while keeping their error codes and user paths intact', async () => {
    const vfs = new SessionVfs([{ path: 'index.html', content: '<h1>用户数据 {0}</h1>' }])
    const tools = buildFileTools(vfs, { onPatch: () => {}, onDelete: () => {} }, {}, 'en-US')
    const result = String(await tools.read_file.execute!({ path: '不存在.html' } as never, options))
    expect(result).toContain('FILE_NOT_FOUND')
    expect(result).toContain('不存在.html')
    expect(result).toMatch(/^Error:/)
    expect(result.replace('不存在.html', '')).not.toMatch(han)
    const content = String(await tools.read_file.execute!({ path: 'index.html' } as never, options))
    expect(content).toContain('<h1>用户数据 {0}</h1>')
  })

  it('uses English weekdays in an English time tool', async () => {
    const tools = buildTimeTools('en-US')
    const result = String(
      await tools.get_current_time.execute!({ timezone: 'UTC' } as never, options)
    )
    expect(result).toContain('Current time:')
    expect(result).not.toMatch(han)
  })

  it('resolves built-in templates when requested rather than at module initialization', () => {
    const english = withLanguage('en-US', roleTemplates)
    const chinese = withLanguage('zh-CN', roleTemplates)
    expect(english[0].id).toBe(chinese[0].id)
    expect(JSON.stringify(english)).not.toMatch(han)
    expect(JSON.stringify(chinese)).toMatch(han)
  })
})

describe('localized protocols', () => {
  it('closes English group handoffs with @user and preserves historical Chinese mentions', () => {
    const members = [{ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', name: 'Reviewer' }]
    expect(
      nextMentions('Done.\n@user Summary\n@Reviewer Optional polish', members, 'other')
    ).toEqual([])
    expect(
      nextMentions('Done.\n@用户 Summary\n@Reviewer Optional polish', members, 'other')
    ).toEqual([])
  })

  it('localizes generated preview errors without embedding translation keys', () => {
    const english = buildBootstrapHtml('vue3', undefined, [], [], 'en-US')
    const chinese = buildBootstrapHtml('react', undefined, [], [], 'zh-CN')
    expect(english).toContain('App.vue must default-export a root component')
    expect(english).toContain('Enable it in')
    expect(english).not.toContain('preview.vueRootRequired')
    expect(chinese).toContain('App.tsx 需要默认导出根组件')
  })

  it('selects plain-chat web instructions explicitly for each language', () => {
    expect(buildChatPrompt({ webSearch: true }, 'en-US')).not.toMatch(han)
    expect(buildChatPrompt({ webSearch: true }, 'zh-CN')).toMatch(han)
  })
})
