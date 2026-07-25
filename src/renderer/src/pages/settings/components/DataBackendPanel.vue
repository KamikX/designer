<script setup lang="ts">
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
    message.warning('主机和数据库名必填')
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
    message.success('已保存。增量同步功能将在后续版本开放,连接参数已就绪')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div style="max-width: 560px">
    <a-form layout="vertical">
      <a-form-item label="数据后端">
        <a-segmented
          v-model:value="mode"
          :options="[
            { label: '本地(默认)', value: 'local' },
            { label: '自建数据库同步', value: 'self-hosted' },
            { label: '官方云服务(敬请期待)', value: 'cloud', disabled: true }
          ]"
        />
        <div style="margin-top: 4px; font-size: 12px; opacity: 0.65">
          所有数据始终保存在本机 SQLite;配置自建 MySQL / PostgreSQL
          后可将数据同步到你自己的服务器,实现多设备与备份。
        </div>
      </a-form-item>

      <template v-if="mode === 'self-hosted'">
        <a-form-item label="数据库类型">
          <a-segmented
            v-model:value="form.dialect"
            :options="[
              { label: 'MySQL', value: 'mysql' },
              { label: 'PostgreSQL', value: 'postgres' }
            ]"
          />
        </a-form-item>
        <a-flex :gap="12">
          <a-form-item label="主机" required style="flex: 2">
            <a-input v-model:value="form.host" placeholder="db.example.com" />
          </a-form-item>
          <a-form-item label="端口" style="flex: 1">
            <a-input-number v-model:value="form.port" :min="1" :max="65535" style="width: 100%" />
          </a-form-item>
        </a-flex>
        <a-flex :gap="12">
          <a-form-item label="数据库名" required style="flex: 1">
            <a-input v-model:value="form.database" />
          </a-form-item>
          <a-form-item label="用户名" style="flex: 1">
            <a-input v-model:value="form.user" autocomplete="off" />
          </a-form-item>
        </a-flex>
        <a-form-item :label="hasPassword ? '密码(已保存,留空沿用)' : '密码'">
          <a-input-password v-model:value="form.password" autocomplete="off" />
        </a-form-item>
        <a-form-item>
          <a-space>
            <a-switch v-model:checked="form.ssl" size="small" />
            <span>SSL 连接</span>
          </a-space>
        </a-form-item>
      </template>

      <a-button type="primary" :loading="saving" @click="save">保存</a-button>
    </a-form>
  </div>
</template>
