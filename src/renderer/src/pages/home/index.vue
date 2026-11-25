<script setup lang="ts">
import { t, uiMessage } from '@renderer/i18n'
import { App, theme } from 'antdv-next'
import { AppstoreOutlined, DeleteOutlined, LoadingOutlined, PlusOutlined } from '@antdv-next/icons'
import dayjs from 'dayjs'
import { useRouter } from 'vue-router'
import { useProjectStore } from '@renderer/stores/project'
import { useChatStore } from '@renderer/stores/chat'
import CreateProjectModal from './components/CreateProjectModal.vue'
import ProjectTags from '@renderer/components/project/ProjectTags.vue'
import type { Project } from '@shared/types'

// 走 App.useApp() 而不是静态导入:静态那份取不到 ConfigProvider 的
// 上下文,主题、语言、z-index 全用的是默认值
const { modal, message } = App.useApp()

const { token } = theme.useToken()
const router = useRouter()
const store = useProjectStore()
store.load()

const createOpen = ref(false)
const importing = ref(false)

async function importProject(): Promise<void> {
  if (importing.value) return
  importing.value = true
  try {
    const result = await window.api.project.importPackage()
    if (!result) return
    await store.load(true)
    if (result.warnings.length) {
      modal.warning({
        title: t('messages.projectImportedSomeSelectionsAreUnavailable'),
        content: result.warnings.join('\n'),
        bodyStyle: { maxHeight: '60vh', overflowY: 'auto', overscrollBehavior: 'contain' }
      })
    } else message.success(t('common.projectImported'))
    openProject(result.project.id)
  } catch (error) {
    message.error(uiMessage(error instanceof Error ? error.message : String(error)))
  } finally {
    importing.value = false
  }
}

/** 正在生成中的项目集合。流状态在 chat store 里全局存着,首页也看得见 */
const chatStore = useChatStore()
const busyProjects = computed(() => {
  const ids = new Set<string>()
  for (const s of Object.values(chatStore.streams)) if (s.projectId) ids.add(s.projectId)
  return ids
})

function openProject(id: string): void {
  router.push(`/project/${id}`)
}

function confirmRemove(p: Project): void {
  modal.confirm({
    title: t('common.deleteProject', p.name),
    content: t('messages.conversationHistoryAndDesignsWillAlsoBePermanentlyDeleted'),
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
    <!--
      空态整页居中,而不是"标题在左上 + 一张孤零零的虚线卡片"。
      一屏一千多像素的宽度只用掉左上角 250px,看着像没做完;而且第一次打开
      应用的人最需要的是"这东西怎么用",不是一个加号。
    -->
    <div v-if="store.loaded && store.projects.length === 0" class="home-empty">
      <div class="home-empty-inner">
        <AppstoreOutlined class="home-empty-icon" :style="{ color: token.colorTextQuaternary }" />
        <h2 class="home-empty-title">{{ t('messages.createYourFirstProject') }}</h2>
        <div class="home-empty-steps" :style="{ color: token.colorTextTertiary }">
          <div>
            {{ t('messages.1ChooseATechnologyStackAndTargetAndDescribeYourProject') }}
          </div>
          <div>
            {{ t('messages.2DescribeWhatYouNeedAndAiWillCreateAWorkingDesign') }}
          </div>
          <div>
            {{ t('messages.3PreviewTheResultAndExportItWhenReady') }}
          </div>
        </div>
        <a-button type="primary" @click="createOpen = true">
          <template #icon><PlusOutlined /></template>
          {{ t('common.newProject') }}
        </a-button>
        <a-button :loading="importing" @click="importProject">{{
          t('common.importProject')
        }}</a-button>
      </div>
    </div>

    <template v-else>
      <div class="home-head">
        <a-button style="float: right" :loading="importing" @click="importProject">{{
          t('common.importProject')
        }}</a-button>
        <div>
          <h1 class="home-title">{{ t('common.projects') }}</h1>
          <div class="home-sub" :style="{ color: token.colorTextTertiary }">
            {{ t('messages.describeYourIdeaAndLetAiCreateADeliverableDesign') }}
          </div>
        </div>
      </div>

      <div class="project-grid">
        <!-- 新建卡片。加号块不上品牌色:它是入口,不是状态 -->
        <button
          class="project-card project-card--new"
          :style="{ borderColor: token.colorBorderSecondary, color: token.colorTextSecondary }"
          @click="createOpen = true"
        >
          <span class="new-plus" :style="{ background: token.colorFillQuaternary }">
            <PlusOutlined />
          </span>
          <span style="font-size: 13px">{{ t('common.newProject') }}</span>
        </button>

        <!-- 项目卡片 -->
        <div
          v-for="p in store.projects"
          :key="p.id"
          class="project-card"
          :style="{ background: token.colorBgContainer, borderColor: token.colorBorderSecondary }"
          @click="openProject(p.id)"
        >
          <div class="card-body">
            <div class="card-name">{{ p.name }}</div>
            <div class="card-desc" :style="{ color: token.colorTextTertiary }">
              {{ p.description || t('common.noDescription') }}
            </div>
            <ProjectTags
              class="card-tags"
              :stack="p.stack"
              :design-mode="p.designMode"
              :targets="p.targets"
            />
          </div>

          <div class="card-foot" :style="{ borderColor: token.colorBorderSecondary }">
            <!-- Keep secondary metadata quiet so the project name remains the entry point. -->
            <span class="card-meta" :style="{ color: token.colorTextQuaternary }">
              {{ fromNow(p.updatedAt) }}
            </span>
            <!-- 唯一上色的地方:真正的状态 -->
            <span
              v-if="busyProjects.has(p.id)"
              class="card-busy"
              :style="{ color: token.colorPrimary }"
            >
              <LoadingOutlined spin /> {{ t('common.generatingLabel') }}
            </span>
            <button
              v-else
              class="card-delete"
              :style="{ color: token.colorTextQuaternary }"
              @click.stop="confirmRemove(p)"
            >
              <DeleteOutlined />
            </button>
          </div>
        </div>
      </div>
    </template>

    <CreateProjectModal v-model:open="createOpen" @created="openProject" />
  </div>
</template>

<style scoped>
/* 页面自己的边距。以前靠 layout-content__inner 统一给,现在各页面自理 */
.home {
  padding: 0 var(--page-pad) var(--page-pad);
  /*
   * min-height 而不是 height:空态要靠 flex 撑满才能垂直居中,而项目多起来
   * 之后网格得能自然长高、交给外层滚动——height:100% 会把它钉死在一屏内。
   */
  min-height: 100%;
  display: flex;
  flex-direction: column;
}

.home-head {
  margin-bottom: 20px;
}

.home-title {
  /* 字号/字重/衬线/字距全部来自 base.css 的 h1——那套排印在这里才第一次真正生效 */
  margin: 0;
}

.home-sub {
  margin-top: 4px;
  font-size: 13px;
}

/* ---------------- 空态:整页居中 ---------------- */

.home-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.home-empty-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}

.home-empty-icon {
  font-size: 28px;
}

.home-empty-title {
  margin: 0;
}

.home-empty-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  line-height: 1.7;
  /* 步骤左对齐:居中的编号列表读起来每行都要重新找起点 */
  text-align: left;
  margin-bottom: 6px;
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
  min-height: 132px;
  text-align: left;
  padding: 0;
}

/*
 * hover 只加深描边,不位移也不上品牌色。
 * 卡片整体上浮是最容易辨认的模板手法之一,而"能点"这件事描边已经说清楚了。
 */
.project-card:hover {
  border-color: var(--border-strong) !important;
  box-shadow: var(--shadow-sm);
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
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

/* 定宽:技术栈/时间这类标注在卡片之间要对得齐 */
.card-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-busy {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
}

.card-body {
  flex: 1;
  padding: 14px 14px 10px;
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

.card-tags {
  margin-top: 10px;
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
