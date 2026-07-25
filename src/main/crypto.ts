import { safeStorage } from 'electron'

/**
 * 密钥加密封装（safeStorage：macOS Keychain / Windows DPAPI / Linux keyring）。
 *
 * 拿不到安全存储时（典型是无 keyring 的 Linux）不拒绝保存——那会让这些
 * 系统完全不可用——而是明文落库并把 storage 标成 'plain'，由设置页显式
 * 警告用户。数据库本来就在用户自己机器上，明文 + 告知是可接受的折中。
 *
 * Linux 上 basic_text 后端是硬编码密钥的伪加密，安全性等同明文，
 * 同样按 'plain' 对待，不给用户虚假的安全感。
 */

export type KeyStorage = 'safe' | 'plain'

function safeAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return false
  }
  return true
}

export function encryptSecret(plain: string): { cipher: string; storage: KeyStorage } {
  if (safeAvailable()) {
    return { cipher: safeStorage.encryptString(plain).toString('base64'), storage: 'safe' }
  }
  return { cipher: Buffer.from(plain, 'utf-8').toString('base64'), storage: 'plain' }
}

/**
 * 解密失败返回 null 而不是抛错——最常见的场景是把数据库拷到了另一台
 * 机器（safeStorage 密钥机器绑定），调用方按"密钥失效，请重新录入"处理。
 */
export function decryptSecret(cipher: string, storage: KeyStorage): string | null {
  try {
    if (storage === 'plain') return Buffer.from(cipher, 'base64').toString('utf-8')
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  } catch {
    return null
  }
}

/** 录入密钥时截取的脱敏提示，如 `sk-a…wxyz`。整条 UI 上只会见到它 */
export function maskKey(plain: string): string {
  if (plain.length <= 8) return '…'
  return `${plain.slice(0, 4)}…${plain.slice(-4)}`
}
