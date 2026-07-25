import type { PreviewLib } from '../../shared/types'

/**
 * 依赖包的 setup 虚拟模块(参考 antdv-next-playground 的 src/antdv-next.js)。
 *
 * 每个需要装配的依赖包对应一个隐藏 JS 模块,由 preview:// 协议按
 * `__setup__/<名字>.js` 直出——**不在产物文件树里**,AI 和用户都看不见,
 * 也就改不坏。统一契约:`export default async (app) => {}`,引导页按勾选
 * 依次 await。
 *
 * 样式为什么在这里用 <link> + 事件加载,而不是引导 HTML 里写死 <link>:
 * CDN 挂掉时,静态 link 的失败是**无声**的——组件功能正常但整页裸奔,
 * 用户只觉得"丑得不对劲"。这里把 error 事件接成 reject,引导页的 catch
 * 会把"样式加载失败 + 具体 URL"报进错误回流,一眼定位到网络问题。
 */

const CDN = 'https://cdn.jsdelivr.net/npm/'

export const LIB_VERSIONS: Record<PreviewLib, string> = {
  'antdv-next': '1.1.0',
  '@antdv-next/icons': '1.0.4'
}

/** setup 虚拟文件名 → 依赖包。icons 只有裸导入没有装配,不需要 setup */
const SETUP_FILES: Record<string, PreviewLib> = {
  'antdv-next.js': 'antdv-next'
}

/** 引导页要 import 的 setup 路径列表(按勾选) */
export function libSetupPaths(libs: PreviewLib[]): string[] {
  return Object.entries(SETUP_FILES)
    .filter(([, lib]) => libs.includes(lib))
    .map(([file]) => `./__setup__/${file}`)
}

/**
 * 按虚拟路径生成 setup 模块源码。
 * @param enabled 项目勾选的依赖包——没勾的返回 null(404),守边界
 */
export function libSetupSource(fileName: string, enabled: PreviewLib[]): string | null {
  const lib = SETUP_FILES[fileName]
  if (!lib || !enabled.includes(lib)) return null

  if (lib === 'antdv-next') {
    const base = `${CDN}antdv-next@${LIB_VERSIONS['antdv-next']}`
    // 顺序必须 reset 在前;两个都要等到 load 才算就绪,否则首帧裸奔闪一下
    return `import Antd from 'antdv-next'

const STYLES = [
  ${JSON.stringify(`${base}/dist/reset.css`)},
  ${JSON.stringify(`${base}/dist/antd.css`)}
]

export default async function setup(app) {
  await loadStyles()
  app.use(Antd)
}

function loadStyles() {
  return Promise.all(STYLES.map((href) => new Promise((resolve, reject) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.addEventListener('load', resolve)
    link.addEventListener('error', () => reject(new Error('样式加载失败:' + href)))
    document.head.append(link)
  })))
}
`
  }
  return null
}
