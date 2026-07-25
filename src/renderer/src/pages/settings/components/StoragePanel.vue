<script setup lang="ts">
import { message } from 'antdv-next'
import type { StorageConfigInput } from '@shared/types'

/**
 * 对象存储配置。图片等二进制资源默认存本地目录;配置 S3 兼容服务后
 * 新资源自动上云。Secret Key 只写不读:表单留空表示沿用已保存的。
 */

const mode = ref<'local' | 's3'>('local')
const hasSecret = ref(false)
const form = reactive({
  endpoint: '',
  region: '',
  bucket: '',
  accessKey: '',
  secretKey: '',
  publicBaseUrl: '',
  forcePathStyle: true
})

async function load(): Promise<void> {
  const config = await window.api.storage.getConfig()
  mode.value = config.mode
  if (config.s3) {
    form.endpoint = config.s3.endpoint
    form.region = config.s3.region === 'auto' ? '' : config.s3.region
    form.bucket = config.s3.bucket
    form.accessKey = config.s3.accessKey
    form.publicBaseUrl = config.s3.publicBaseUrl
    form.forcePathStyle = config.s3.forcePathStyle
    hasSecret.value = config.s3.hasSecret
  }
}
load()

function buildInput(): StorageConfigInput {
  return {
    mode: mode.value,
    s3:
      mode.value === 's3'
        ? {
            endpoint: form.endpoint.trim(),
            region: form.region.trim() || undefined,
            bucket: form.bucket.trim(),
            accessKey: form.accessKey.trim(),
            secretKey: form.secretKey.trim() || undefined,
            publicBaseUrl: form.publicBaseUrl.trim() || undefined,
            forcePathStyle: form.forcePathStyle
          }
        : undefined
  }
}

const saving = ref(false)
const testing = ref(false)
const testResult = ref('')

async function save(): Promise<void> {
  if (mode.value === 's3' && (!form.endpoint.trim() || !form.bucket.trim())) {
    message.warning('Endpoint 和 Bucket 必填')
    return
  }
  saving.value = true
  try {
    const next = await window.api.storage.setConfig(buildInput())
    hasSecret.value = next.s3?.hasSecret ?? false
    form.secretKey = ''
    message.success('已保存')
  } finally {
    saving.value = false
  }
}

async function runTest(): Promise<void> {
  testing.value = true
  testResult.value = ''
  try {
    const r = await window.api.storage.test(buildInput())
    testResult.value = r.ok ? `✓ 连通,${r.latencyMs ?? 0}ms` : `✗ ${r.error}`
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div style="max-width: 560px">
    <a-form layout="vertical">
      <a-form-item label="存储位置">
        <a-segmented
          v-model:value="mode"
          :options="[
            { label: '本地目录(默认)', value: 'local' },
            { label: 'S3 兼容服务', value: 's3' }
          ]"
        />
      </a-form-item>

      <template v-if="mode === 's3'">
        <a-form-item label="Endpoint" required>
          <a-input
            v-model:value="form.endpoint"
            placeholder="https://minio.example.com 或 R2/OSS/COS 端点"
          />
        </a-form-item>
        <a-flex :gap="12">
          <a-form-item label="Bucket" required style="flex: 1">
            <a-input v-model:value="form.bucket" />
          </a-form-item>
          <a-form-item label="Region" style="flex: 1">
            <a-input v-model:value="form.region" placeholder="留空为 auto" />
          </a-form-item>
        </a-flex>
        <a-form-item label="Access Key">
          <a-input v-model:value="form.accessKey" autocomplete="off" />
        </a-form-item>
        <a-form-item :label="hasSecret ? 'Secret Key(已保存,留空沿用)' : 'Secret Key'">
          <a-input-password v-model:value="form.secretKey" autocomplete="off" />
        </a-form-item>
        <a-form-item label="自定义访问域名(CDN,可选)">
          <a-input v-model:value="form.publicBaseUrl" placeholder="https://cdn.example.com" />
        </a-form-item>
        <a-form-item>
          <a-space>
            <a-switch v-model:checked="form.forcePathStyle" size="small" />
            <span>Path-style 访问(MinIO 等自建服务需要开启)</span>
          </a-space>
        </a-form-item>
      </template>

      <a-space>
        <a-button type="primary" :loading="saving" @click="save">保存</a-button>
        <a-button v-if="mode === 's3'" :loading="testing" @click="runTest">测试连接</a-button>
        <span v-if="testResult">{{ testResult }}</span>
      </a-space>
    </a-form>
  </div>
</template>
