import { describe, expect, it } from 'vitest'
import { mapToolErrorCode, redactTraceText, sanitizeToolTrace } from './tool-trace-sanitizer'

/**
 * 每类工具族都用带密钥/敏感值的输入打一遍:白名单之外的任何字段
 * 都不允许出现在目标摘要里。
 */

const SECRET = 'sk-live-abcdef1234567890abcdef'

describe('设计稿文件工具', () => {
  it('只保留通过 VFS 校验的相对路径', () => {
    const meta = sanitizeToolTrace('read_file', {
      path: 'pages/index.vue',
      note: SECRET
    })
    expect(meta.targetSummary).toBe('pages/index.vue')
    expect(JSON.stringify(meta)).not.toContain(SECRET)
  })

  it('非法路径(绝对/越界)不保留,不能收"看起来像路径"的任意串', () => {
    expect(sanitizeToolTrace('write_file', { path: '/etc/passwd' }).targetSummary).toBeNull()
    expect(sanitizeToolTrace('edit_file', { path: '../../secret.txt' }).targetSummary).toBeNull()
  })

  it('搜索只保留查询长度,不保留搜索词', () => {
    const query = `密码是 ${SECRET}`
    const meta = sanitizeToolTrace('search_files', { query })
    expect(meta.targetSummary).toBe(`查询 ${query.length} 字符`)
    expect(JSON.stringify(meta)).not.toContain('sk-live')
  })
})

describe('本地 workspace 工具', () => {
  it('路径只保留不可逆哈希与扩展名', () => {
    const meta = sanitizeToolTrace('read_local_file', {
      path: '/Users/alice/company-secrets/salary.xlsx'
    })
    expect(meta.targetSummary).toMatch(/^[0-9a-f]{12}\.xlsx$/)
    expect(meta.targetSummary).not.toContain('salary')
    expect(meta.targetSummary).not.toContain('alice')
  })

  it('无扩展名时只有哈希', () => {
    const meta = sanitizeToolTrace('list_local_dir', { path: '/Users/alice/项目资料' })
    expect(meta.targetSummary).toMatch(/^[0-9a-f]{12}$/)
  })
})

describe('URL 与搜索工具', () => {
  it('URL 只保留 host,路径与查询串丢弃', () => {
    const meta = sanitizeToolTrace('web_fetch', {
      url: `https://example.com/reset-password?token=${SECRET}`
    })
    expect(meta.targetSummary).toBe('example.com')
  })

  it('联网搜索只保留查询长度', () => {
    const query = '我的邮箱 a@b.com 泄露了吗'
    const meta = sanitizeToolTrace('web_search', { query })
    expect(meta.targetSummary).toBe(`查询 ${query.length} 字符`)
  })
})

describe('技能 / 提问 / MCP', () => {
  it('activate_skill 允许保留技能名', () => {
    expect(sanitizeToolTrace('activate_skill', { name: 'craft-admin' }).targetSummary).toBe(
      'craft-admin'
    )
  })

  it('ask_user 只保留题目/选项数量', () => {
    const meta = sanitizeToolTrace('ask_user', {
      questions: [
        { question: `请输入密钥 ${SECRET}`, options: [{ label: 'A' }, { label: 'B' }] },
        { question: '第二题', options: [{ label: 'C' }] }
      ]
    })
    expect(meta.targetSummary).toBe('2 题 3 选项')
    expect(JSON.stringify(meta)).not.toContain('sk-live')
  })

  it('MCP 工具只保留 server_tool 名,不保留任何字段值', () => {
    const meta = sanitizeToolTrace(
      'github_create_issue',
      { title: `密钥 ${SECRET}`, body: '正文' },
      { mcp: true }
    )
    expect(meta.targetSummary).toBe('github_create_issue')
    expect(JSON.stringify(meta)).not.toContain('sk-live')
  })
})

describe('未注册工具', () => {
  it('没有目标摘要,只有大小类元数据', () => {
    const meta = sanitizeToolTrace('mystery_tool', { anything: SECRET })
    expect(meta.targetSummary).toBeNull()
  })
})

describe('错误码映射', () => {
  it('VfsError 与已知错误映射为固定码', async () => {
    const { VfsError } = await import('./vfs-error')
    expect(mapToolErrorCode(new VfsError(`路径 /Users/x 不合法 ${SECRET}`))).toBe(
      'TOOL_EXECUTION_FAILED'
    )
  })

  it('HTTP 状态映射为 UPSTREAM 码,原始 body 不外漏', () => {
    const err = Object.assign(new Error(`{"error":"bad key ${SECRET}"}`), { statusCode: 429 })
    expect(mapToolErrorCode(err)).toBe('UPSTREAM_RATE_LIMITED')
    const err2 = Object.assign(new Error('boom'), { statusCode: 502 })
    expect(mapToolErrorCode(err2)).toBe('UPSTREAM_ERROR')
  })

  it('未知错误一律固定回退码', () => {
    expect(mapToolErrorCode(new Error(SECRET))).toBe('TOOL_EXECUTION_FAILED')
    expect(mapToolErrorCode('随便什么')).toBe('TOOL_EXECUTION_FAILED')
  })
})

describe('二次脱敏', () => {
  it('路径、URL、邮箱、凭证形态全部打码并截断到 240 字符', () => {
    const dirty = [
      '出错于 /Users/alice/work/project/file.ts',
      'C:\\Users\\bob\\secret.docx',
      'https://api.example.com/v1/keys?k=abc',
      '邮箱 alice@example.com',
      `密钥 ${SECRET}`,
      `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload`,
      'x'.repeat(300)
    ].join(' ')
    const clean = redactTraceText(dirty)
    expect(clean.length).toBeLessThanOrEqual(240)
    expect(clean).not.toContain('alice')
    expect(clean).not.toContain('example.com/v1')
    expect(clean).not.toContain('sk-live')
    expect(clean).not.toContain('eyJhbGci')
    expect(clean).not.toContain('C:\\Users')
  })

  it('普通中文错误摘要原样保留', () => {
    expect(redactTraceText('旧文本在文件中出现了 3 次,无法唯一定位')).toBe(
      '旧文本在文件中出现了 3 次,无法唯一定位'
    )
  })
})
