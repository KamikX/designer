<script setup lang="ts">
import { t } from '@renderer/i18n'
import { App } from 'antdv-next'

// 走 App.useApp() 而不是静态导入:静态那份取不到 ConfigProvider 的
// 上下文,主题、语言、z-index 全用的是默认值
const { message } = App.useApp()

/**
 * 数据与同步。本期只做模式选择与连接参数保存(同步引擎二期上线):
 * - 本地:默认,零配置;
 * - 自建数据库:保存 MySQL/PG 连接参数,密码加密落盘;
 * - 官方云服务:预留,置灰。
 */

const mode = ref<'local' | 'self-hosted' | 'cloud'>('local')
const hasPassword = ref(false)
const form = reactive({
  dialect: 'mysql' as 'mysql' | 'postgres',
  host: '',
  port: 3306,
  database: '',
  user: '',
  password: '',
  ssl: false
})

async function load(): Promise<void> {
  const config = await window.api.sync.getConfig()
  mode.value = config.mode
  if (config.selfHosted) {
    Object.assign(form, {
      dialect: config.selfHosted.dialect,
      host: config.selfHosted.host,
      port: config.selfHosted.port,
      database: config.selfHosted.database,
      user: config.selfHosted.user,
      ssl: config.selfHosted.ssl
    })
    hasPassword.value = config.selfHosted.hasPassword
  }
}
load()

watch(
  () => form.dialect,
  (d) => {
    if (form.port === 3306 || form.port === 5432) form.port = d === 'mysql' ? 3306 : 5432
  }
)

const saving = ref(false)

async function save(): Promise<void> {
  if (mode.value === 'self-hosted' && (!form.host.trim() || !form.database.trim())) {
    message.warning(t('messages.hostAndDatabaseNameAreRequired'))
    return
  }
  saving.value = true
  try {
    const next = await window.api.sync.setConfig({
      mode: mode.value,
      selfHosted:
        mode.value === 'self-hosted'
          ? {
              dialect: form.dialect,
              host: form.host.trim(),
              port: form.port,
              database: form.database.trim(),
              user: form.user.trim(),
              password: form.password.trim() || undefined,
              ssl: form.ssl
            }
          : undefined
    })
    hasPassword.value = next.selfHosted?.hasPassword ?? false
    form.password = ''
    message.success(t('messages.savedIncrementalSyncWillBeAvailable'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div style="max-width: 560px">
    <a-form layout="vertical">
      <a-form-item :label="t('common.dataBackend')">
        <a-segmented
          v-model:value="mode"
          :options="[
            {
              get label() {
                return t('common.localDefault')
              },
              value: 'local'
            },
            {
              get label() {
                return t('common.selfHostedDatabaseSync')
              },
              value: 'self-hosted'
            },
            {
              get label() {
                return t('messages.officialCloudServiceComingSoon')
              },
              value: 'cloud',
              disabled: true
            }
          ]"
        />
        <div style="margin-top: 4px; font-size: 12px; opacity: 0.65">
          {{ t('messages.allDataIsStoredLocallyIn') }}
        </div>
      </a-form-item>

      <template v-if="mode === 'self-hosted'">
        <a-form-item :label="t('common.databaseType')">
          <a-segmented
            v-model:value="form.dialect"
            :options="[
              { label: 'MySQL', value: 'mysql' },
              { label: 'PostgreSQL', value: 'postgres' }
            ]"
          />
        </a-form-item>
        <a-flex :gap="12">
          <a-form-item :label="t('common.host')" required style="flex: 2">
            <a-input v-model:value="form.host" placeholder="db.example.com" />
          </a-form-item>
          <a-form-item :label="t('common.port')" style="flex: 1">
            <a-input-number v-model:value="form.port" :min="1" :max="65535" style="width: 100%" />
          </a-form-item>
        </a-flex>
        <a-flex :gap="12">
          <a-form-item :label="t('common.databaseName')" required style="flex: 1">
            <a-input v-model:value="form.database" />
          </a-form-item>
          <a-form-item :label="t('common.username')" style="flex: 1">
            <a-input v-model:value="form.user" autocomplete="off" />
          </a-form-item>
        </a-flex>
        <a-form-item
          :label="hasPassword ? t('messages.passwordSavedLeaveBlankToKeep') : t('common.password')"
        >
          <a-input-password v-model:value="form.password" autocomplete="off" />
        </a-form-item>
        <a-form-item>
          <a-space>
            <a-switch v-model:checked="form.ssl" size="small" />
            <span>{{ t('common.sslConnection') }}</span>
          </a-space>
        </a-form-item>
      </template>

      <a-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</a-button>
    </a-form>
  </div>
</template>
