<script setup lang="ts">
import { App, theme } from 'antdv-next'
import { ImportOutlined, PlusOutlined } from '@antdv-next/icons'
import type { McpServer, McpTransport } from '@shared/types'

// 走 App.useApp() 而不是静态导入:静态那份取不到 ConfigProvider 的
// 上下文,主题、语言、z-index 全用的是默认值
const { message, modal } = App.useApp()

/**
 * MCP 服务配置。支持两种录入方式:
 * - JSON 导入:直接粘贴 Claude Desktop / Cursor 同款的 mcpServers JSON;
 * - 手动添加:stdio(命令行)或 sse/http(远程端点)表单。
 * 本页只管配置;连接与工具发现在对话链路接入时实现。
 */

const { token } = theme.useToken()

const servers = ref<McpServer[]>([])
const loaded = ref(false)

async function load(): Promise<void> {
  servers.value = await window.api.mcp.list()
  loaded.value = true
}
load()

const TRANSPORT_LABEL: Record<string, string> = {
  stdio: '本地进程',
  sse: 'SSE',
  http: 'HTTP'
}

function summary(s: McpServer): string {
  if (s.transport === 'stdio') return [s.command, ...s.args].filter(Boolean).join(' ')
  return s.url ?? ''
}

/* ---------------- JSON 导入 ---------------- */

const importModal = reactive({ open: false, json: '', importing: false })

const IMPORT_PLACEHOLDER = `{
  "mcpServers": {
    "figma": {
      "command": "npx",
      "args": ["-y", "figma-mcp"],
      "env": { "FIGMA_TOKEN": "..." }
    },
    "browser": { "url": "http://localhost:3845/sse" }
  }
}`

async function doImport(): Promise<void> {
  if (!importModal.json.trim()) return
  importModal.importing = true
  try {
    const created = await window.api.mcp.importJson(importModal.json)
    servers.value.push(...created)
    importModal.open = false
    importModal.json = ''
    message.success(`已导入 ${created.length} 个服务`)
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    importModal.importing = false
  }
}

/* ---------------- 手动添加 / 编辑抽屉 ---------------- */

const drawer = reactive({
  open: false,
  editing: null as McpServer | null,
  name: '',
  transport: 'stdio' as McpTransport,
  command: '',
  /** 一行一个参数 */
  argsText: '',
  /** 一行一条 KEY=VALUE */
  envText: '',
  url: '',
  /** 一行一条 KEY: VALUE */
  headersText: '',
  saving: false
})

function openAdd(): void {
  Object.assign(drawer, {
    open: true,
    editing: null,
    name: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    envText: '',
    url: '',
    headersText: ''
  })
}

function openEdit(s: McpServer): void {
  Object.assign(drawer, {
    open: true,
    editing: s,
    name: s.name,
    transport: s.transport,
    command: s.command ?? '',
    argsText: s.args.join('\n'),
    envText: Object.entries(s.env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    url: s.url ?? '',
    headersText: Object.entries(s.headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
  })
}

function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

function parseKv(text: string, sep: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of parseLines(text)) {
    const i = line.indexOf(sep)
    if (i <= 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

async function save(): Promise<void> {
  if (!drawer.name.trim()) {
    message.warning('请填写名称')
    return
  }
  if (drawer.transport === 'stdio' && !drawer.command.trim()) {
    message.warning('stdio 方式需要填写启动命令')
    return
  }
  if (drawer.transport !== 'stdio' && !drawer.url.trim()) {
    message.warning('远程方式需要填写 URL')
    return
  }
  drawer.saving = true
  try {
    const input = {
      name: drawer.name.trim(),
      transport: drawer.transport,
      command: drawer.transport === 'stdio' ? drawer.command.trim() : undefined,
      args: drawer.transport === 'stdio' ? parseLines(drawer.argsText) : undefined,
      env: drawer.transport === 'stdio' ? parseKv(drawer.envText, '=') : undefined,
      url: drawer.transport !== 'stdio' ? drawer.url.trim() : undefined,
      headers: drawer.transport !== 'stdio' ? parseKv(drawer.headersText, ':') : undefined
    }
    if (drawer.editing) {
      const next = await window.api.mcp.update(drawer.editing.id, input)
      if (next) {
        const i = servers.value.findIndex((s) => s.id === next.id)
        if (i >= 0) servers.value[i] = next
      }
    } else {
      servers.value.push(await window.api.mcp.create(input))
    }
    drawer.open = false
    message.success('已保存')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    drawer.saving = false
  }
}

async function toggle(s: McpServer, enabled: boolean): Promise<void> {
  const next = await window.api.mcp.update(s.id, { enabled })
  if (next) {
    const i = servers.value.findIndex((x) => x.id === next.id)
    if (i >= 0) servers.value[i] = next
  }
}

function confirmRemove(s: McpServer): void {
  modal.confirm({
    title: `删除 MCP 服务「${s.name}」?`,
    okType: 'danger',
    onOk: async () => {
      await window.api.mcp.remove(s.id)
      servers.value = servers.value.filter((x) => x.id !== s.id)
    }
  })
}
</script>

<template>
  <div style="max-width: 800px">
    <a-flex justify="space-between" align="center" style="margin-bottom: 12px">
      <span style="font-size: 12px; opacity: 0.65">
        MCP 服务为 AI 提供外部工具(设计资源、浏览器、文件系统等),将在对话中自动可用
      </span>
      <a-space>
        <a-button @click="importModal.open = true">
          <template #icon><ImportOutlined /></template>
          JSON 导入
        </a-button>
        <a-button type="primary" @click="openAdd">
          <template #icon><PlusOutlined /></template>
          手动添加
        </a-button>
      </a-space>
    </a-flex>

    <a-empty
      v-if="loaded && servers.length === 0"
      description="还没有配置 MCP 服务"
      style="margin-top: 80px"
    >
      <a-space>
        <a-button @click="importModal.open = true">JSON 导入</a-button>
        <a-button type="primary" @click="openAdd">手动添加</a-button>
      </a-space>
    </a-empty>

    <div v-else class="mcp-cards">
      <div
        v-for="s in servers"
        :key="s.id"
        class="mcp-card"
        :style="{ borderColor: token.colorBorderSecondary }"
        @click="openEdit(s)"
      >
        <a-flex justify="space-between" align="center" :gap="12">
          <div style="min-width: 0">
            <a-space :size="6">
              <span style="font-weight: 600">{{ s.name }}</span>
              <a-tag style="margin: 0">{{ TRANSPORT_LABEL[s.transport] }}</a-tag>
            </a-space>
            <div class="mcp-card-desc">{{ summary(s) }}</div>
          </div>
          <a-space :size="10" @click.stop>
            <a style="color: var(--ant-color-error); font-size: 13px" @click="confirmRemove(s)">
              删除
            </a>
            <a-switch :checked="s.enabled" size="small" @change="(v: boolean) => toggle(s, v)" />
          </a-space>
        </a-flex>
      </div>
    </div>

    <a-modal
      v-model:open="importModal.open"
      title="导入 mcpServers JSON"
      :confirm-loading="importModal.importing"
      :width="560"
      @ok="doImport"
    >
      <div style="font-size: 12px; opacity: 0.65; margin-bottom: 8px">
        粘贴 Claude Desktop / Cursor 同款格式的配置,同名服务会跳过
      </div>
      <a-textarea
        v-model:value="importModal.json"
        :rows="12"
        :placeholder="IMPORT_PLACEHOLDER"
        style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px"
      />
    </a-modal>

    <a-drawer
      v-model:open="drawer.open"
      :title="drawer.editing ? `配置 — ${drawer.editing.name}` : '添加 MCP 服务'"
      size="large"
      destroy-on-close
    >
      <a-form layout="vertical">
        <a-form-item label="名称" required>
          <a-input v-model:value="drawer.name" placeholder="如 figma / browser" />
        </a-form-item>

        <a-form-item label="连接方式">
          <a-segmented
            v-model:value="drawer.transport"
            :options="[
              { label: '本地进程(stdio)', value: 'stdio' },
              { label: 'SSE', value: 'sse' },
              { label: 'HTTP', value: 'http' }
            ]"
          />
        </a-form-item>

        <template v-if="drawer.transport === 'stdio'">
          <a-form-item label="启动命令" required>
            <a-input v-model:value="drawer.command" placeholder="npx / uvx / node …" />
          </a-form-item>
          <a-form-item label="参数(一行一个)">
            <a-textarea
              v-model:value="drawer.argsText"
              :rows="4"
              placeholder="-y&#10;figma-mcp"
              style="font-family: ui-monospace, Menlo, monospace; font-size: 12px"
            />
          </a-form-item>
          <a-form-item label="环境变量(一行一条,KEY=VALUE)">
            <a-textarea
              v-model:value="drawer.envText"
              :rows="3"
              placeholder="FIGMA_TOKEN=xxx"
              style="font-family: ui-monospace, Menlo, monospace; font-size: 12px"
            />
          </a-form-item>
        </template>

        <template v-else>
          <a-form-item label="URL" required>
            <a-input v-model:value="drawer.url" placeholder="http://localhost:3845/sse" />
          </a-form-item>
          <a-form-item label="请求头(一行一条,KEY: VALUE)">
            <a-textarea
              v-model:value="drawer.headersText"
              :rows="3"
              placeholder="Authorization: Bearer xxx"
              style="font-family: ui-monospace, Menlo, monospace; font-size: 12px"
            />
          </a-form-item>
        </template>
      </a-form>

      <template #footer>
        <a-flex justify="flex-end" :gap="8">
          <a-button @click="drawer.open = false">取消</a-button>
          <a-button type="primary" :loading="drawer.saving" @click="save">保存</a-button>
        </a-flex>
      </template>
    </a-drawer>
  </div>
</template>

<style scoped>
.mcp-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mcp-card {
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.mcp-card:hover {
  border-color: var(--ant-color-primary) !important;
}

.mcp-card-desc {
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.65;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
