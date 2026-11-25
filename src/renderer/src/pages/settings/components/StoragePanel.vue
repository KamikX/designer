<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { App } from 'antdv-next'
import type { StorageConfigInput } from '@shared/types'

// 走 App.useApp() 而不是静态导入:静态那份取不到 ConfigProvider 的
// 上下文,主题、语言、z-index 全用的是默认值
const { message } = App.useApp()

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
    message.warning(t('messages.endpointAndBucketAreRequired'))
    return
  }
  saving.value = true
  try {
    const next = await window.api.storage.setConfig(buildInput())
    hasSecret.value = next.s3?.hasSecret ?? false
    form.secretKey = ''
    message.success(t('common.saved'))
  } finally {
    saving.value = false
  }
}

async function runTest(): Promise<void> {
  testing.value = true
  testResult.value = ''
  try {
    const r = await window.api.storage.test(buildInput())
    testResult.value = r.ok ? t('common.connectedMs', r.latencyMs ?? 0) : `✗ ${uiMessage(r.error)}`
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div style="max-width: 560px">
    <a-form layout="vertical">
      <a-form-item :label="t('common.storageLocation')">
        <a-segmented
          v-model:value="mode"
          :options="[
            {
              get label() {
                return t('common.localDirectoryDefault')
              },
              value: 'local'
            },
            {
              get label() {
                return t('common.s3CompatibleService')
              },
              value: 's3'
            }
          ]"
        />
      </a-form-item>

      <template v-if="mode === 's3'">
        <a-form-item label="Endpoint" required>
          <a-input
            v-model:value="form.endpoint"
            :placeholder="t('messages.httpsMinioExampleComOrAnR2OssCosEndpoint')"
          />
        </a-form-item>
        <a-flex :gap="12">
          <a-form-item label="Bucket" required style="flex: 1">
            <a-input v-model:value="form.bucket" />
          </a-form-item>
          <a-form-item label="Region" style="flex: 1">
            <a-input v-model:value="form.region" :placeholder="t('messages.leaveBlankForAuto')" />
          </a-form-item>
        </a-flex>
        <a-form-item label="Access Key">
          <a-input v-model:value="form.accessKey" autocomplete="off" />
        </a-form-item>
        <a-form-item
          :label="hasSecret ? t('messages.secretKeySavedLeaveBlankToKeep') : 'Secret Key'"
        >
          <a-input-password v-model:value="form.secretKey" autocomplete="off" />
        </a-form-item>
        <a-form-item :label="t('messages.customDomainCdnOptional')">
          <a-input v-model:value="form.publicBaseUrl" placeholder="https://cdn.example.com" />
        </a-form-item>
        <a-form-item>
          <a-space>
            <a-switch v-model:checked="form.forcePathStyle" size="small" />
            <span>{{ t('messages.pathStyleAccessRequiredForSelfHostedServicesSuchAsMinio') }}</span>
          </a-space>
        </a-form-item>
      </template>

      <a-space>
        <a-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</a-button>
        <a-button v-if="mode === 's3'" :loading="testing" @click="runTest">{{
          t('common.testConnection')
        }}</a-button>
        <span v-if="testResult">{{ testResult }}</span>
      </a-space>
    </a-form>
  </div>
</template>
