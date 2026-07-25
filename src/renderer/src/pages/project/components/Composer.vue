<script setup lang="ts">
import { theme } from 'antdv-next'
import {
  ApiOutlined,
  ArrowUpOutlined,
  BulbOutlined,
  SettingOutlined,
  StopOutlined
} from '@antdv-next/icons'
import { useRouter } from 'vue-router'
import { useChatStore } from '@renderer/stores/chat'
import ModelSelect from './ModelSelect.vue'
import type { McpServer, Skill } from '@shared/types'

/**
 * 一体化输入框:无边框多行输入 + 底部工具条。
 * 工具条左侧:模型选择、MCP 服务选择器、技能选择器;右侧:发送/停止。
 * MCP 与技能的勾选是"本会话生效"的内存态,存在 chat store,
 * 运行时接入后随请求下发。
 */

const props = defineProps<{ disabled?: boolean }>()
const emit = defineEmits<{ send: [text: string] }>()

const { token } = theme.useToken()
const router = useRouter()
const chatStore = useChatStore()

const draft = ref('')

function send(): void {
  const text = draft.value.trim()
  if (!text || chatStore.streaming || props.disabled) return
  draft.value = ''
  emit('send', text)
}

function onEnter(e: KeyboardEvent): void {
  // Enter 发送,Shift+Enter 换行(输入法组合期间不触发)
  if (e.shiftKey || e.isComposing) return
  e.preventDefault()
  send()
}

/* ---------------- MCP / 技能 选择器 ---------------- */

const mcpServers = ref<McpServer[]>([])
const skills = ref<Skill[]>([])

async function loadToolbox(): Promise<void> {
  const [m, s] = await Promise.all([window.api.mcp.list(), window.api.skill.list()])
  mcpServers.value = m
  skills.value = s
  // 默认勾选全局启用的那些
  if (chatStore.mcpIds == null) {
    chatStore.mcpIds = m.filter((x) => x.enabled).map((x) => x.id)
  }
  if (chatStore.skillIds == null) {
    chatStore.skillIds = s.filter((x) => x.enabled).map((x) => x.id)
  }
}
loadToolbox()

const mcpCount = computed(() => chatStore.mcpIds?.length ?? 0)
const skillCount = computed(() => chatStore.skillIds?.length ?? 0)

function toggleId(list: string[] | null, id: string): string[] {
  const set = new Set(list ?? [])
  if (set.has(id)) set.delete(id)
  else set.add(id)
  return [...set]
}
</script>

<template>
  <div
    class="composer"
    :style="{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }"
  >
    <a-textarea
      v-model:value="draft"
      class="composer-input"
      placeholder="描述你的设计需求,例如:做一个深色风格的数据看板首页…"
      :auto-size="{ minRows: 2, maxRows: 8 }"
      :disabled="disabled"
      variant="borderless"
      @keydown.enter="onEnter"
    />

    <div class="composer-toolbar">
      <a-flex align="center" :gap="4" style="min-width: 0">
        <ModelSelect />

        <span class="composer-divider" :style="{ background: token.colorBorderSecondary }" />

        <!-- MCP 服务选择 -->
        <a-popover trigger="click" placement="topLeft">
          <template #content>
            <div class="toolbox-pop">
              <div class="toolbox-pop-title">本会话使用的 MCP 服务</div>
              <a-empty
                v-if="mcpServers.length === 0"
                description="还没有配置 MCP 服务"
                :image-style="{ height: '48px' }"
              />
              <label v-for="s in mcpServers" :key="s.id" class="toolbox-pop-row">
                <a-checkbox
                  :checked="chatStore.mcpIds?.includes(s.id)"
                  @change="chatStore.mcpIds = toggleId(chatStore.mcpIds, s.id)"
                />
                <span class="toolbox-pop-name">{{ s.name }}</span>
                <span class="toolbox-pop-meta">{{ s.transport }}</span>
              </label>
              <a class="toolbox-pop-manage" @click="router.push('/settings')">
                <SettingOutlined /> 管理 MCP 服务
              </a>
            </div>
          </template>
          <button class="toolbox-btn" :style="{ color: token.colorTextSecondary }" type="button">
            <ApiOutlined />
            <span>MCP</span>
            <span v-if="mcpCount" class="toolbox-badge" :style="{ background: token.colorPrimary }">
              {{ mcpCount }}
            </span>
          </button>
        </a-popover>

        <!-- 技能选择 -->
        <a-popover trigger="click" placement="topLeft">
          <template #content>
            <div class="toolbox-pop">
              <div class="toolbox-pop-title">本会话使用的技能</div>
              <a-empty
                v-if="skills.length === 0"
                description="还没有配置技能"
                :image-style="{ height: '48px' }"
              />
              <label v-for="s in skills" :key="s.id" class="toolbox-pop-row">
                <a-checkbox
                  :checked="chatStore.skillIds?.includes(s.id)"
                  @change="chatStore.skillIds = toggleId(chatStore.skillIds, s.id)"
                />
                <span class="toolbox-pop-name">{{ s.name }}</span>
                <span class="toolbox-pop-meta">{{ s.description }}</span>
              </label>
              <a class="toolbox-pop-manage" @click="router.push('/settings')">
                <SettingOutlined /> 管理技能
              </a>
            </div>
          </template>
          <button class="toolbox-btn" :style="{ color: token.colorTextSecondary }" type="button">
            <BulbOutlined />
            <span>技能</span>
            <span
              v-if="skillCount"
              class="toolbox-badge"
              :style="{ background: token.colorPrimary }"
            >
              {{ skillCount }}
            </span>
          </button>
        </a-popover>
      </a-flex>

      <!-- 发送 / 停止 -->
      <a-tooltip :title="chatStore.streaming ? '停止生成' : 'Enter 发送,Shift+Enter 换行'">
        <a-button
          v-if="chatStore.streaming"
          danger
          type="primary"
          shape="circle"
          @click="chatStore.abort()"
        >
          <template #icon><StopOutlined /></template>
        </a-button>
        <a-button
          v-else
          type="primary"
          shape="circle"
          :disabled="!draft.trim() || disabled"
          @click="send"
        >
          <template #icon><ArrowUpOutlined /></template>
        </a-button>
      </a-tooltip>
    </div>
  </div>
</template>

<style scoped>
.composer {
  border: 1px solid transparent;
  border-radius: 14px;
  padding: 4px 8px 8px;
  transition: border-color 0.2s;
}

.composer:focus-within {
  border-color: var(--ant-color-primary);
}

/* 输入框本体去掉边框和聚焦光晕,由外层容器承担 */
.composer-input,
.composer-input:focus {
  border: none !important;
  box-shadow: none !important;
  outline: none;
  resize: none;
  font-size: 13px;
  line-height: 1.7;
  background: transparent !important;
}

.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 2px 0 4px;
}

.composer-divider {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  flex-shrink: 0;
}

.toolbox-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 8px;
  transition: background 0.15s;
}

.toolbox-btn:hover {
  background: rgba(128, 128, 128, 0.12);
}

.toolbox-badge {
  min-width: 16px;
  height: 16px;
  border-radius: 8px;
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  padding: 0 4px;
}

.toolbox-pop {
  width: 260px;
}

.toolbox-pop-title {
  font-size: 12px;
  font-weight: 600;
  opacity: 0.75;
  margin-bottom: 8px;
}

.toolbox-pop-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  cursor: pointer;
}

.toolbox-pop-name {
  font-size: 13px;
  flex-shrink: 0;
}

.toolbox-pop-meta {
  font-size: 12px;
  opacity: 0.45;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.toolbox-pop-manage {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  font-size: 12px;
}
</style>
