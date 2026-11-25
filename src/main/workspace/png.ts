import { text as appText } from '../i18n'
import { deflateSync } from 'zlib'

/**
 * 把 BGRA 原始位图编成 PNG。
 *
 * PDFium 渲染出来的是裸位图,要变成能喂给模型的图片就得编码一次。
 * 三条路里选了自己写:
 *
 * - `sharp` / `@napi-rs/canvas`:原生二进制,每平台一份几十 MB,而我们只
 *   需要"无压缩比要求地把 RGBA 变成 PNG"这一件事
 * - Electron 的 `nativeImage.createFromBitmap`:够用,但会让这个模块依赖
 *   electron,于是 vitest 里跑不了——文档相关的测试全是在纯 node 下跑的
 * - **自己编**:PNG 的最小合法结构就是 IHDR + IDAT + IEND,zlib 是 node
 *   自带的,四十行搞定,而且纯函数可单测
 *
 * 只做 8 位真彩色 + alpha、filter type 0(不做行间预测)。压缩率比不过
 * 专业编码器,但这些图是即时发给模型的,不落盘也不长期保存,不值得为几个
 * 百分点的体积引一个原生依赖。
 */

/** PNG 每个块都要带 CRC32,这里按标准多项式现算一张表 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let c = 0xffffffff
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/**
 * @param bgra PDFium 给的是 BGRA 顺序,不是 RGBA——直接当 RGBA 编出来
 *             红蓝会互换,截图看上去像老照片
 */
export function bgraToPng(bgra: Uint8Array, width: number, height: number): Buffer {
  if (bgra.length < width * height * 4) {
    throw new Error(
      appText(
        'messages.insufficientBitmapDataExpectedBytesReceived',
        width * height * 4,
        bgra.length
      )
    )
  }

  // 每行前面要加一个 filter 字节(0 = 不预测)
  const raw = Buffer.alloc(height * (1 + width * 4))
  let out = 0
  for (let y = 0; y < height; y++) {
    raw[out++] = 0
    let read = y * width * 4
    for (let x = 0; x < width; x++) {
      raw[out++] = bgra[read + 2] // R ← B 位
      raw[out++] = bgra[read + 1] // G
      raw[out++] = bgra[read] // B ← R 位
      raw[out++] = bgra[read + 3] // A
      read += 4
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 颜色类型:真彩色 + alpha
  ihdr[10] = 0 // 压缩方法(只有 deflate)
  ihdr[11] = 0 // 过滤方法
  ihdr[12] = 0 // 逐行扫描,不做隔行

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
