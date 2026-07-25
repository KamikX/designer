<script setup lang="ts">
import { theme, Modal } from 'antdv-next'
import { DeleteOutlined, PlusOutlined } from '@antdv-next/icons'
import dayjs from 'dayjs'
import { useRouter } from 'vue-router'
import { useProjectStore } from '@renderer/stores/project'
import CreateProjectModal from './components/CreateProjectModal.vue'
import type { Project, Stack } from '@shared/types'

const { token } = theme.useToken()
const router = useRouter()
const store = useProjectStore()
store.load()

const createOpen = ref(false)

/** 每个技术栈一套主题色,卡片顶部的渐变条与徽标共用 */
const STACK_META: Record<Stack, { label: string; color: string; gradient: string }> = {
  html: {
    label: 'HTML',
    color: '#e8662c',
    gradient: 'linear-gradient(135deg, #ff8a4c33, #ffb45c14)'
  },
  vue3: {
    label: 'Vue 3',
    color: '#31a06e',
    gradient: 'linear-gradient(135deg, #42d39222, #35b98014)'
  },
  react: {
    label: 'React',
    color: '#2f7fd6',
    gradient: 'linear-gradient(135deg, #58c3ff2b, #3a8fd914)'
  }
}

const MODE_LABEL: Record<string, string> = { design: 'UI 设计', prototype: '原型' }

function openProject(id: string): void {
  router.push(`/project/${id}`)
}

function confirmRemove(p: Project): void {
  Modal.confirm({
    title: `删除项目「${p.name}」?`,
    content: '对话记录与设计稿会一并删除,不可恢复。',
    okType: 'danger',
    onOk: () => store.remove(p.id)
  })
}

function fromNow(time: string): string {
  const d = dayjs(time)
  return dayjs().diff(d, 'day') >= 180 ? d.format('YYYY-MM-DD') : d.format('MM-DD HH:mm')
}
</script>

<template>
  <div class="home">
    <div class="home-head">
      <div>
        <div class="home-title">项目</div>
        <div class="home-sub">从一句需求开始,让 AI 帮你产出可交付的设计稿</div>
      </div>
    </div>

    <div class="project-grid">
      <!-- 新建卡片 -->
      <button
        class="project-card project-card--new"
        :style="{ borderColor: token.colorBorderSecondary, color: token.colorTextSecondary }"
        @click="createOpen = true"
      >
        <span
          class="new-plus"
          :style="{ background: token.colorPrimaryBg, color: token.colorPrimary }"
        >
          <PlusOutlined />
        </span>
        <span style="font-size: 13px">新建项目</span>
      </button>

      <!-- 项目卡片 -->
      <div
        v-for="p in store.projects"
        :key="p.id"
        class="project-card"
        :style="{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }"
        @click="openProject(p.id)"
      >
        <div class="card-banner" :style="{ background: STACK_META[p.stack].gradient }">
          <span class="card-stack" :style="{ color: STACK_META[p.stack].color }">
            <i class="card-stack-dot" :style="{ background: STACK_META[p.stack].color }" />
            {{ STACK_META[p.stack].label }}
          </span>
          <span class="card-mode" :style="{ color: token.colorTextTertiary }">
            {{ MODE_LABEL[p.designMode] }}
          </span>
        </div>

        <div class="card-body">
          <div class="card-name">{{ p.name }}</div>
          <div class="card-desc" :style="{ color: token.colorTextTertiary }">
            {{ p.description || '暂无描述' }}
          </div>
        </div>

        <div class="card-foot" :style="{ borderColor: token.colorBorderSecondary }">
          <span :style="{ color: token.colorTextQuaternary, fontSize: '12px' }">
            {{ fromNow(p.updatedAt) }}
          </span>
          <button
            class="card-delete"
            :style="{ color: token.colorTextQuaternary }"
            @click.stop="confirmRemove(p)"
          >
            <DeleteOutlined />
          </button>
        </div>
      </div>
    </div>

    <CreateProjectModal v-model:open="createOpen" @created="openProject" />
  </div>
</template>

<style scoped>
.home-head {
  margin-bottom: 20px;
}

.home-title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.5px;
}

.home-sub {
  margin-top: 4px;
  font-size: 13px;
  opacity: 0.55;
}

.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}

.project-card {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid transparent;
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease,
    border-color 0.18s ease;
  min-height: 168px;
  text-align: left;
  padding: 0;
}

.project-card:hover {
  transform: translateY(-2px);
  border-color: var(--ant-color-primary) !important;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
}

/* 新建卡片:虚线空位 */
.project-card--new {
  border-style: dashed;
  background: transparent;
  align-items: center;
  justify-content: center;
  gap: 10px;
}

.project-card--new:hover {
  box-shadow: none;
  transform: none;
}

.new-plus {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.card-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
}

.card-stack {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
}

.card-stack-dot {
  width: 8px;
  height: 8px;
  border-radius: 3px;
  display: inline-block;
}

.card-mode {
  font-size: 12px;
}

.card-body {
  flex: 1;
  padding: 10px 14px 8px;
  min-height: 0;
}

.card-name {
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-desc {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-top: 1px solid transparent;
}

.card-delete {
  border: none;
  background: none;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.project-card:hover .card-delete {
  opacity: 1;
}

.card-delete:hover {
  color: var(--ant-color-error) !important;
}
</style>
