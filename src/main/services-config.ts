import { text as appText } from './i18n'
import { readFileSync, writeFileSync } from 'fs'
import type {
  DataBackendInput,
  DataBackendView,
  StorageConfigInput,
  StorageConfigView
} from '../shared/types'
import { decryptSecret, encryptSecret } from './crypto'
import type { KeyStorage } from './crypto'
import { SERVICES_FILE, ensureDataDirs } from './paths'

/**
 * 数据后端 / 对象存储配置(services.json)。
 *
 * 刻意不放进 config.json:那份配置整个对象会走 config:read / read-sync
 * 直达渲染进程,而这里有密文。本文件只在主进程读写,对外只出
 * View 形(hasSecret / hasPassword 掩码)。
 */

interface StoredSecret {
  cipher: string
  storage: KeyStorage
}

interface ServicesConfig {
  storage: {
    mode: 'local' | 's3'
    s3: {
      endpoint: string
      region: string
      bucket: string
      accessKey: string
      secret: StoredSecret | null
      publicBaseUrl: string
      forcePathStyle: boolean
    } | null
  }
  dataBackend: {
    mode: 'local' | 'self-hosted' | 'cloud'
    selfHosted: {
      dialect: 'mysql' | 'postgres'
      host: string
      port: number
      database: string
      user: string
      password: StoredSecret | null
      ssl: boolean
    } | null
  }
}

const DEFAULT: ServicesConfig = {
  storage: { mode: 'local', s3: null },
  dataBackend: { mode: 'local', selfHosted: null }
}

let cache: ServicesConfig | null = null

function read(): ServicesConfig {
  if (cache) return cache
  ensureDataDirs()
  try {
    const raw = JSON.parse(readFileSync(SERVICES_FILE, 'utf-8'))
    cache = {
      storage: { ...DEFAULT.storage, ...raw.storage },
      dataBackend: { ...DEFAULT.dataBackend, ...raw.dataBackend }
    }
  } catch {
    cache = structuredClone(DEFAULT)
  }
  return cache
}

function persist(): void {
  writeFileSync(SERVICES_FILE, JSON.stringify(cache, null, 2))
}

/* ---------------- storage ---------------- */

export function storageView(): StorageConfigView {
  const { storage } = read()
  return {
    mode: storage.mode,
    s3: storage.s3
      ? {
          endpoint: storage.s3.endpoint,
          region: storage.s3.region,
          bucket: storage.s3.bucket,
          accessKey: storage.s3.accessKey,
          hasSecret: storage.s3.secret != null,
          publicBaseUrl: storage.s3.publicBaseUrl,
          forcePathStyle: storage.s3.forcePathStyle
        }
      : null
  }
}

export function setStorageConfig(input: StorageConfigInput): StorageConfigView {
  const config = read()
  if (input.s3) {
    const prev = config.storage.s3
    config.storage.s3 = {
      endpoint: input.s3.endpoint,
      region: input.s3.region ?? 'auto',
      bucket: input.s3.bucket,
      accessKey: input.s3.accessKey,
      // 不传 secretKey = 沿用已存密文(编辑表单回显不了密钥,这是常态)
      secret: input.s3.secretKey ? encryptSecret(input.s3.secretKey) : (prev?.secret ?? null),
      publicBaseUrl: input.s3.publicBaseUrl ?? '',
      forcePathStyle: input.s3.forcePathStyle ?? true
    }
  }
  config.storage.mode = input.mode
  persist()
  return storageView()
}

/** 仅主进程 storage service 使用 */
export function s3Credentials(): {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  publicBaseUrl: string
  forcePathStyle: boolean
} | null {
  const { storage } = read()
  if (!storage.s3?.secret) return null
  const secretKey = decryptSecret(storage.s3.secret.cipher, storage.s3.secret.storage)
  if (secretKey == null) return null
  return {
    endpoint: storage.s3.endpoint,
    region: storage.s3.region,
    bucket: storage.s3.bucket,
    accessKey: storage.s3.accessKey,
    secretKey,
    publicBaseUrl: storage.s3.publicBaseUrl,
    forcePathStyle: storage.s3.forcePathStyle
  }
}

export function storageMode(): 'local' | 's3' {
  return read().storage.mode
}

/* ---------------- data backend ---------------- */

export function dataBackendView(): DataBackendView {
  const { dataBackend } = read()
  return {
    mode: dataBackend.mode,
    selfHosted: dataBackend.selfHosted
      ? {
          dialect: dataBackend.selfHosted.dialect,
          host: dataBackend.selfHosted.host,
          port: dataBackend.selfHosted.port,
          database: dataBackend.selfHosted.database,
          user: dataBackend.selfHosted.user,
          hasPassword: dataBackend.selfHosted.password != null,
          ssl: dataBackend.selfHosted.ssl
        }
      : null
  }
}

export function setDataBackendConfig(input: DataBackendInput): DataBackendView {
  const config = read()
  // cloud 是给官方 SaaS 版预留的枚举,落地前不允许选中
  if (input.mode === 'cloud')
    throw new Error(appText('messages.theOfficialCloudServiceIsNotAvailableYet'))
  if (input.selfHosted) {
    const prev = config.dataBackend.selfHosted
    config.dataBackend.selfHosted = {
      dialect: input.selfHosted.dialect,
      host: input.selfHosted.host,
      port: input.selfHosted.port,
      database: input.selfHosted.database,
      user: input.selfHosted.user,
      password: input.selfHosted.password
        ? encryptSecret(input.selfHosted.password)
        : (prev?.password ?? null),
      ssl: input.selfHosted.ssl ?? false
    }
  }
  config.dataBackend.mode = input.mode
  persist()
  return dataBackendView()
}
