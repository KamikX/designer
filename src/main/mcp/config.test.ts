import { describe, expect, it } from 'vitest'
import { expand, resolveConfig } from './config'

/**
 * `${VAR}` 展开是密钥不落地方案的关键一环:配置文件里只有占位符,真值在加密
 * 存储里,展开只发生在启动进程前的内存中。
 *
 * 最要紧的一条是**缺变量时不要换成空串**——那样服务会带着空 token 启动,然后
 * 报一个和"没配密钥"毫不相干的认证错误,查起来极费劲。
 */

describe('展开', () => {
  it('取到值就替换', () => {
    expect(expand('Bearer ${TOKEN}', { TOKEN: 'abc' }).text).toBe('Bearer abc')
  })

  it('缺变量时**保留原样**并记下来,不换空串', () => {
    const out = expand('Bearer ${TOKEN}', {})
    expect(out.text).toBe('Bearer ${TOKEN}')
    expect(out.missing).toEqual(['TOKEN'])
  })

  it('空串等同于没有——空 token 和没 token 一样不能用', () => {
    expect(expand('${TOKEN}', { TOKEN: '' }).missing).toEqual(['TOKEN'])
  })

  it('支持默认值语法', () => {
    expect(expand('${BASE:-https://api.example.com}/mcp', {}).text).toBe(
      'https://api.example.com/mcp'
    )
  })

  it('有默认值就不算缺失', () => {
    expect(expand('${BASE:-x}', {}).missing).toEqual([])
  })

  it('一句话里多个变量各自处理', () => {
    const out = expand('${A}/${B}', { A: 'a' })
    expect(out.text).toBe('a/${B}')
    expect(out.missing).toEqual(['B'])
  })

  it('不像变量的 $ 不动它', () => {
    expect(expand('cost: $5 and ${X}', { X: '1' }).text).toBe('cost: $5 and 1')
  })
})

describe('整条配置展开', () => {
  it('command / args / env / url / headers 都覆盖到', () => {
    const { config } = resolveConfig(
      {
        command: '${BIN}',
        args: ['-y', '${PKG}'],
        env: { TOKEN: '${T}' },
        url: 'https://${HOST}/mcp',
        headers: { Authorization: 'Bearer ${T}' }
      },
      { BIN: 'npx', PKG: 'pkg', T: 'secret', HOST: 'example.com' }
    )
    expect(config.command).toBe('npx')
    expect(config.args).toEqual(['-y', 'pkg'])
    expect(config.env).toEqual({ TOKEN: 'secret' })
    expect(config.url).toBe('https://example.com/mcp')
    expect(config.headers).toEqual({ Authorization: 'Bearer secret' })
  })

  it('缺失的变量去重后一起返回', () => {
    const { missing } = resolveConfig(
      { command: 'npx', env: { A: '${T}', B: '${T}' }, headers: { H: '${U}' } },
      {}
    )
    expect(missing.sort()).toEqual(['T', 'U'])
  })

  it('没有变量时原样返回', () => {
    const { config, missing } = resolveConfig({ command: 'npx', args: ['-y', 'x'] }, {})
    expect(config.args).toEqual(['-y', 'x'])
    expect(missing).toEqual([])
  })
})
