import { text as appText } from '../i18n'
/**
 * 按魔数识别文件格式。
 *
 * ## 它不负责"能不能读",只负责"这是什么"
 *
 * 判定一个文件能不能当文本读,靠的是 text.ts 里的 UTF-8 严格解码——那才是
 * 直接回答问题的判据。魔数回答的是另一个问题:"这是什么已知格式"。两者
 * 不能互相替代:
 *
 * - GBK 编码的 .txt **没有魔数**,识别结果是 null,但它确实读不了
 * - 自定义二进制格式同样没魔数
 * - 反过来,魔数表也识别不了纯文本(文本本来就没有固定头部)
 *
 * 所以这里的定位是**诊断层**,给已经判定"读不了"的文件补一句人话:
 * 与其说"含有 NUL 字节",不如说"这是 PNG 图片"。
 *
 * ## 还能抓后缀说谎的文件
 *
 * 一个被重命名成 .txt 的 PDF,后缀黑名单和 UTF-8 解码都只会说"读不了",
 * 而真正该做的是转去 read_local_document。魔数能看出这一点。
 *
 * 不引 file-type 之类的库:我们真正在意的就下面这十来种,手写一张表零依赖、
 * 可控、错误文案还能直接写中文。
 */

export interface FormatInfo {
  /** 给模型看的格式名 */
  label: string
  /**
   * 这个格式能被 read_local_document 解析。用于纠正后缀说谎的情况:
   * 一个叫 notes.txt 的 PDF,应当被引导去用文档工具而不是简单地拒绝。
   */
  readableAsDocument?: boolean
}

interface Signature {
  /** 字节序列;null 表示该位任意 */
  bytes: (number | null)[]
  offset?: number
  info: FormatInfo
}

const SIGNATURES: Signature[] = [
  {
    bytes: [0x25, 0x50, 0x44, 0x46],
    info: {
      get label() {
        return appText('workspace.magic.pdfDocument')
      },
      readableAsDocument: true
    }
  },
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    info: {
      get label() {
        return appText('workspace.magic.pngImage')
      }
    }
  },
  {
    bytes: [0xff, 0xd8, 0xff],
    info: {
      get label() {
        return appText('workspace.magic.jpegImage')
      }
    }
  },
  {
    bytes: [0x47, 0x49, 0x46, 0x38],
    info: {
      get label() {
        return appText('workspace.magic.gifImage')
      }
    }
  },
  // RIFF....WEBP:中间四字节是长度,跳过
  {
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
    info: {
      get label() {
        return appText('workspace.magic.webpImage')
      }
    }
  },
  {
    bytes: [0x00, 0x00, 0x01, 0x00],
    info: {
      get label() {
        return appText('workspace.magic.icoIcon')
      }
    }
  },
  {
    bytes: [0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66],
    info: {
      get label() {
        return appText('workspace.magic.sqliteDatabase')
      }
    }
  },
  {
    bytes: [0x1f, 0x8b],
    info: {
      get label() {
        return appText('workspace.magic.gzipArchive')
      }
    }
  },
  {
    bytes: [0x42, 0x5a, 0x68],
    info: {
      get label() {
        return appText('workspace.magic.bzip2Archive')
      }
    }
  },
  {
    bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
    info: {
      get label() {
        return appText('workspace.magic.7zArchive')
      }
    }
  },
  {
    bytes: [0x52, 0x61, 0x72, 0x21],
    info: {
      get label() {
        return appText('workspace.magic.rarArchive')
      }
    }
  },
  {
    bytes: [0x7f, 0x45, 0x4c, 0x46],
    info: {
      get label() {
        return appText('workspace.magic.elfExecutable')
      }
    }
  },
  {
    bytes: [0xcf, 0xfa, 0xed, 0xfe],
    info: {
      get label() {
        return appText('workspace.magic.machOExecutable')
      }
    }
  },
  {
    bytes: [0x4d, 0x5a],
    info: {
      get label() {
        return appText('workspace.magic.windowsExecutable')
      }
    }
  },
  {
    bytes: [0xca, 0xfe, 0xba, 0xbe],
    info: {
      get label() {
        return appText('workspace.magic.javaClassFile')
      }
    }
  },
  {
    bytes: [0x00, 0x61, 0x73, 0x6d],
    info: {
      get label() {
        return appText('workspace.magic.webassemblyModule')
      }
    }
  },
  {
    bytes: [0x00, 0x01, 0x00, 0x00, 0x00],
    info: {
      get label() {
        return appText('workspace.magic.truetypeFont')
      }
    }
  },
  {
    bytes: [0x77, 0x4f, 0x46, 0x46],
    info: {
      get label() {
        return appText('workspace.magic.woffFont')
      }
    }
  },
  {
    bytes: [0x77, 0x4f, 0x46, 0x32],
    info: {
      get label() {
        return appText('workspace.magic.woff2Font')
      }
    }
  },
  {
    // docx / xlsx / pptx / jar / epub 全是 zip 容器,魔数分不出来——
    // 只能如实说是 zip,具体类型交给后缀
    bytes: [0x50, 0x4b, 0x03, 0x04],
    info: {
      get label() {
        return appText('workspace.magic.zipContainerUsedByDocxXlsxOrdinaryArchives')
      }
    }
  }
]

export function identify(head: Buffer): FormatInfo | null {
  for (const signature of SIGNATURES) {
    const offset = signature.offset ?? 0
    if (head.length < offset + signature.bytes.length) continue
    let hit = true
    for (let i = 0; i < signature.bytes.length; i++) {
      const expected = signature.bytes[i]
      if (expected === null) continue
      if (head[offset + i] !== expected) {
        hit = false
        break
      }
    }
    if (hit) return signature.info
  }
  return null
}
