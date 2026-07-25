import { nativeImage } from 'electron'

/**
 * 图片入库前的预处理。
 *
 * ## 为什么一定要缩放
 *
 * 各家模型都按**像素尺寸**计费,而且都会先把超过自己原生分辨率的图降
 * 采样再处理。也就是说超出的那部分像素:上行带宽白付、可能撞上单图
 * 大小限制、而模型根本不会多看一眼。在本地缩到位是纯赚。
 *
 * 一张 4K 截图缩到长边 1600px,体积通常从几 MB 掉到几百 KB,而设计参考
 * 图需要的信息(布局、配色、间距节奏)一点没少。
 *
 * ## 为什么不无脑重编码
 *
 * 不需要缩放时原样入库:重编码会掉画质(jpeg)、丢动画(gif)、丢透明
 * 通道处理上的细节,而这些图本来就不大,省不出什么。只有真的超尺寸了
 * 才动它——那时的损失换的是实打实的成本下降。
 *
 * 用 Electron 自带的 nativeImage,不引第三方图像库。
 */

/** 长边上限。各家原生分辨率大致在 1568~2576 之间,取一个通用的保守值 */
const MAX_EDGE = 1600

/** 各家普遍接受的图片类型 */
const SUPPORTED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

export interface PreparedImage {
  data: Buffer
  mime: string
  width: number
  height: number
  /** 是否真的动过 */
  resized: boolean
}

export class ImageError extends Error {}

export function prepareImage(data: Buffer, mime: string, name: string): PreparedImage {
  if (mime === 'image/svg+xml') {
    // SVG 各家基本都不收当图片,而且它是可执行的标记语言,不该直接喂
    throw new ImageError(`${name} 是 SVG,模型无法识别。请导出成 PNG 再试。`)
  }
  if (!SUPPORTED.has(mime)) {
    throw new ImageError(`${name} 的格式(${mime})不支持,请用 PNG / JPEG / GIF / WebP。`)
  }

  const image = nativeImage.createFromBuffer(data)
  if (image.isEmpty()) {
    // 解不开的一律原样放行:可能是某平台 nativeImage 不认的 webp 变体,
    // 交给供应商去判断,总好过我们在这里武断地拒绝
    return { data, mime, width: 0, height: 0, resized: false }
  }

  const { width, height } = image.getSize()
  const longest = Math.max(width, height)
  if (longest <= MAX_EDGE) {
    return { data, mime, width, height, resized: false }
  }

  const scale = MAX_EDGE / longest
  const resized = image.resize({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    quality: 'best'
  })
  const size = resized.getSize()

  // jpeg 保持 jpeg(照片类,有损可接受);其余一律转 png 保住锐利边缘,
  // 截图和 UI 稿转成 jpeg 会在文字边上糊出一圈杂色
  const asJpeg = mime === 'image/jpeg'
  return {
    data: asJpeg ? resized.toJPEG(88) : resized.toPNG(),
    mime: asJpeg ? 'image/jpeg' : 'image/png',
    width: size.width,
    height: size.height,
    resized: true
  }
}
