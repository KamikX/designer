// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from 'vitest'
import { ANNOTATE_RUNTIME } from './annotate-runtime'

/**
 * 标注运行时是一段字符串,打包器和类型检查都看不见它——**只有这里能发现它坏了**。
 *
 * 重点盯两件事:
 * 1. 元素签名的内容(源码坐标、文本、class、selector),模型全靠它定位;
 * 2. 关掉标注时不能吞掉页面自己的点击——那会让预览"点不动",而且没有任何报错。
 */

/**
 * 把 <script> 里的正文抠出来在当前文档跑一遍,模拟 iframe 加载。
 *
 * 只 boot 一次:运行时把监听挂在 document 上,每个用例再跑一遍就会叠出
 * 多个实例,"关掉标注"那条用例会被上一个还开着的实例弄假。
 */
beforeAll(() => {
  const code = /<script>([\s\S]*)<\/script>/.exec(ANNOTATE_RUNTIME)?.[1]
  if (!code) throw new Error('标注运行时里找不到 script 正文')
  new Function(code)()
})

/** 运行时用 parent.postMessage 上报;happy-dom 里 parent 就是 window */
function nextMessage(type: string): Promise<Record<string, never>> {
  return new Promise((resolve) => {
    const onMessage = (e: MessageEvent): void => {
      if (e.data?.__preview && e.data.type === type) {
        window.removeEventListener('message', onMessage)
        resolve(e.data)
      }
    }
    window.addEventListener('message', onMessage)
  })
}

function command(data: Record<string, unknown>): Promise<void> {
  window.postMessage(data, '*')
  // postMessage 是异步派发的,等一个微任务队列排空
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('标注运行时', () => {
  it('点中元素上报的签名够模型定位', async () => {
    document.body.innerHTML = `
      <div class="card">
        <form>
          <button class="px-4 py-2" data-antd-src="components/LoginForm.vue:42:7" type="submit">
            提交
          </button>
        </form>
      </div>`
    await command({ __previewCmd: 'annotate', on: true })

    const picked = nextMessage('annotate:pick')
    document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const data = (await picked) as unknown as { target: Record<string, unknown> }

    expect(data.target).toMatchObject({
      source: 'components/LoginForm.vue:42:7',
      tag: 'button',
      text: '提交',
      classes: ['px-4', 'py-2'],
      // 祖先链带上元素自己(含首个 class),重复结构里靠它区分
      path: 'div.card > form > button.px-4',
      attrs: { type: 'submit' }
    })
    // selector 要能被 querySelector 原样吃回去——徽标复原全靠它
    expect(document.querySelector(String(data.target.selector))).toBe(
      document.querySelector('button')
    )
  })

  it('祖先带源码坐标时也算数(标到内层文字节点的情况)', async () => {
    document.body.innerHTML = `
      <section data-antd-src="App.vue:8:3"><span class="t">标题</span></section>`
    await command({ __previewCmd: 'annotate', on: true })

    const picked = nextMessage('annotate:pick')
    document.querySelector('span')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const data = (await picked) as unknown as { target: Record<string, unknown> }

    expect(data.target.source).toBe('App.vue:8:3')
    expect(data.target.tag).toBe('span')
  })

  it('没开标注时不拦页面自己的点击', async () => {
    document.body.innerHTML = `<button id="b">x</button>`
    await command({ __previewCmd: 'annotate', on: false })

    let clicked = 0
    document.querySelector('#b')!.addEventListener('click', () => clicked++)
    document.querySelector('#b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(clicked).toBe(1)

    // 开了之后页面的监听就该被挡住:这时点击是"标记",不是"使用页面"
    await command({ __previewCmd: 'annotate', on: true })
    document.querySelector('#b')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(clicked).toBe(1)
  })
})
