<script setup lang="ts">
import { message, Modal, theme } from 'antdv-next'
import { ImportOutlined, PlusOutlined } from '@antdv-next/icons'
import type { Skill } from '@shared/types'

/**
 * 技能配置:可复用的提示词包(设计规范、组件库偏好、行业模板等)。
 * 启用的技能将注入设计对话的 system prompt(链路接入在后续里程碑)。
 */

const { token } = theme.useToken()

const skills = ref<Skill[]>([])
const loaded = ref(false)

async function load(): Promise<void> {
  skills.value = await window.api.skill.list()
  loaded.value = true
}
load()

const importing = ref(false)

/** 导入技能压缩包:zip 内必须包含 SKILL.md(frontmatter 的 name/description 自动识别) */
async function importPackage(): Promise<void> {
  importing.value = true
  try {
    const skill = await window.api.skill.importPackage()
    if (skill) {
      skills.value.push(skill)
      message.success(`已导入技能「${skill.name}」`)
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    importing.value = false
  }
}

const drawer = reactive({
  open: false,
  editing: null as Skill | null,
  name: '',
  description: '',
  content: '',
  saving: false
})

function openAdd(): void {
  Object.assign(drawer, { open: true, editing: null, name: '', description: '', content: '' })
}

function openEdit(s: Skill): void {
  Object.assign(drawer, {
    open: true,
    editing: s,
    name: s.name,
    description: s.description,
    content: s.content
  })
}

async function save(): Promise<void> {
  if (!drawer.name.trim() || !drawer.content.trim()) {
    message.warning('名称和内容必填')
    return
  }
  drawer.saving = true
  try {
    const input = {
      name: drawer.name.trim(),
      description: drawer.description.trim(),
      content: drawer.content.trim()
    }
    if (drawer.editing) {
      const next = await window.api.skill.update(drawer.editing.id, input)
      if (next) {
        const i = skills.value.findIndex((s) => s.id === next.id)
        if (i >= 0) skills.value[i] = next
      }
    } else {
      skills.value.push(await window.api.skill.create(input))
    }
    drawer.open = false
    message.success('已保存')
  } catch (err) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    drawer.saving = false
  }
}

async function toggle(s: Skill, enabled: boolean): Promise<void> {
  const next = await window.api.skill.update(s.id, { enabled })
  if (next) {
    const i = skills.value.findIndex((x) => x.id === next.id)
    if (i >= 0) skills.value[i] = next
  }
}

function confirmRemove(s: Skill): void {
  Modal.confirm({
    title: `删除技能「${s.name}」?`,
    okType: 'danger',
    onOk: async () => {
      await window.api.skill.remove(s.id)
      skills.value = skills.value.filter((x) => x.id !== s.id)
    }
  })
}
</script>

<template>
  <div style="max-width: 800px">
    <a-flex justify="space-between" align="center" style="margin-bottom: 12px">
      <span style="font-size: 12px; opacity: 0.65">
        技能是可复用的提示词包(设计规范、品牌风格、组件库偏好…),启用后自动注入设计对话
      </span>
      <a-space>
        <a-tooltip title="zip 压缩包,必须包含 SKILL.md">
          <a-button :loading="importing" @click="importPackage">
            <template #icon><ImportOutlined /></template>
            导入技能包
          </a-button>
        </a-tooltip>
        <a-button type="primary" @click="openAdd">
          <template #icon><PlusOutlined /></template>
          添加技能
        </a-button>
      </a-space>
    </a-flex>

    <a-empty
      v-if="loaded && skills.length === 0"
      description="还没有配置技能"
      style="margin-top: 80px"
    >
      <a-space>
        <a-button :loading="importing" @click="importPackage">导入技能包</a-button>
        <a-button type="primary" @click="openAdd">添加技能</a-button>
      </a-space>
    </a-empty>

    <div v-else class="skill-cards">
      <div
        v-for="s in skills"
        :key="s.id"
        class="skill-card"
        :style="{ borderColor: token.colorBorderSecondary }"
        @click="openEdit(s)"
      >
        <a-flex justify="space-between" align="center" :gap="12">
          <div style="min-width: 0">
            <span style="font-weight: 600">{{ s.name }}</span>
            <div class="skill-card-desc">{{ s.description || s.content.slice(0, 80) }}</div>
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

    <a-drawer
      v-model:open="drawer.open"
      :title="drawer.editing ? `编辑 — ${drawer.editing.name}` : '添加技能'"
      size="large"
      destroy-on-close
    >
      <a-form layout="vertical">
        <a-form-item label="名称" required>
          <a-input v-model:value="drawer.name" placeholder="如 品牌视觉规范 / 移动端适配要求" />
        </a-form-item>
        <a-form-item label="描述">
          <a-input v-model:value="drawer.description" placeholder="一句话说明这个技能是干什么的" />
        </a-form-item>
        <a-form-item label="内容" required>
          <a-textarea
            v-model:value="drawer.content"
            :rows="14"
            placeholder="写给 AI 的指令,例如:&#10;主色使用 #1677FF,圆角统一 8px;&#10;所有按钮高度 40px;&#10;文案语气专业克制,不用感叹号。"
          />
        </a-form-item>
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
.skill-cards {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.skill-card {
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s;
}

.skill-card:hover {
  border-color: var(--ant-color-primary) !important;
}

.skill-card-desc {
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.65;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
