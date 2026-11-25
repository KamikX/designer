<script setup lang="ts">
import { t } from '@renderer/i18n'
import { theme } from 'antdv-next'
import {
  ApiOutlined,
  CloudSyncOutlined,
  DatabaseOutlined,
  SettingOutlined
} from '@antdv-next/icons'
import { useProviderStore } from '@renderer/stores/provider'
import LibrariesPanel from './components/LibrariesPanel.vue'
import GeneralPanel from './components/GeneralPanel.vue'
import ProviderPanel from './components/ProviderPanel.vue'
import DataBackendPanel from './components/DataBackendPanel.vue'
import StoragePanel from './components/StoragePanel.vue'

/**
 * 设置页:二级侧边栏形态。
 * 左侧是设置项分组导航,右侧是对应的配置面板,和主侧栏形成两级结构。
 */

const { token } = theme.useToken()
const store = useProviderStore()
store.load()

const SECTIONS = [
  {
    key: 'general',
    get label() {
      return t('common.general')
    },
    icon: SettingOutlined,
    component: GeneralPanel
  },
  {
    key: 'providers',
    get label() {
      return t('common.aiProviders')
    },
    icon: ApiOutlined,
    component: ProviderPanel
  },
  {
    key: 'libraries',
    get label() {
      return t('common.librariesLabel')
    },
    icon: DatabaseOutlined,
    component: LibrariesPanel
  },
  {
    key: 'data',
    get label() {
      return t('common.dataAndSync')
    },
    icon: CloudSyncOutlined,
    component: DataBackendPanel
  },
  {
    key: 'storage',
    get label() {
      return t('common.objectStorage')
    },
    icon: DatabaseOutlined,
    component: StoragePanel
  }
] as const

const active = ref<(typeof SECTIONS)[number]['key']>('general')

const current = computed(() => SECTIONS.find((s) => s.key === active.value)!)
</script>

<template>
  <div class="settings-page">
    <div class="settings" :style="{ background: token.colorBgContainer }">
      <div class="settings-sider" :style="{ borderColor: token.colorBorderSecondary }">
        <div
          v-for="s in SECTIONS"
          :key="s.key"
          class="settings-nav-item"
          :class="{ 'settings-nav-item--active': active === s.key }"
          :style="
            active === s.key
              ? { background: token.colorPrimaryBg, color: token.colorPrimary }
              : undefined
          "
          @click="active = s.key"
        >
          <component :is="s.icon" />
          <span>{{ s.label }}</span>
        </div>
      </div>

      <div class="settings-content">
        <h2 class="settings-content-title">{{ current.label }}</h2>
        <component :is="current.component" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 外边距要加在外层:.settings 本身是一张有底色和圆角的卡片,padding 加在
 * 它身上会变成卡片内部的留白,卡片仍然贴着窗口边。
 */
.settings-page {
  height: 100%;
  padding: 0 var(--page-pad) var(--page-pad);
}

.settings {
  display: flex;
  height: 100%;
  min-height: 0;
  border-radius: 8px;
  overflow: hidden;
}

.settings-sider {
  width: 168px;
  flex-shrink: 0;
  padding: 12px 8px;
  border-right: 1px solid transparent;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.settings-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  transition: background 0.15s;
}

.settings-nav-item:not(.settings-nav-item--active):hover {
  background: rgba(128, 128, 128, 0.1);
}

.settings-content {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 24px 24px;
}

.settings-content-title {
  margin: 0 0 16px;
}
</style>
