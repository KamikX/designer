<script setup lang="ts">
import { theme } from 'antdv-next'
import { useAppConfig } from '@renderer/components/config/config'
import { FOOTER_MENU_ITEMS, MENU_ITEMS } from './menu'
import { DRAG_BAR_HEIGHT, RAIL_WIDTH } from './use-layout'

const route = useRoute()
const router = useRouter()
const { token } = theme.useToken()
const { dark } = useAppConfig()
const menuItems = computed(() =>
  MENU_ITEMS.map((item) =>
    item && 'label' in item
      ? {
          ...item,
          label: item.label
        }
      : item
  )
)
const footerMenuItems = computed(() =>
  FOOTER_MENU_ITEMS.map((item) =>
    item && 'label' in item
      ? {
          ...item,
          label: item.label
        }
      : item
  )
)

// 侧栏跟着整体明暗走。底色统一由 config.ts 算好写在 --app-rail-bg 上，
// 开毛玻璃时它是半透明的，这里不能再写死不透明色
const siderTheme = computed(() => (dark.value ? 'dark' : 'light'))

const menuStyle = computed(() => ({
  // inline 菜单自带一条右侧分隔线，这里不需要
  borderInlineEnd: 'none',
  width: `${RAIL_WIDTH}px`,
  background: 'transparent'
}))

// key 就是路由 path，选中态直接由当前路由反查。
// 上下两个菜单共用这一份，只有命中的那个会高亮
const selectedKeys = computed(() => [route.path])

function onMenuClick({ key }: { key: string | number }): void {
  const path = String(key)
  if (path !== route.path) router.push(path)
}
</script>

<template>
  <a-layout-sider
    :theme="siderTheme"
    :width="RAIL_WIDTH"
    class="layout-rail"
    :style="{
      background: 'var(--app-rail-bg)',
      borderInlineEnd: `1px solid ${token.colorBorderSecondary}`
    }"
  >
    <!-- 整条导轨都能拖窗口，只有菜单本身排除掉 -->
    <div class="layout-rail__body app-drag">
      <!-- 红绿灯落在这块留白上 -->
      <div class="layout-rail__top" :style="{ height: `${DRAG_BAR_HEIGHT}px` }" />

      <!-- 布局样式一律挂在自己的 div 上：Menu 设了 inheritAttrs: false，
           不透传 scoped 属性，写在它身上的 scoped 规则不会生效 -->
      <div class="layout-rail__nav app-no-drag">
        <a-menu
          :theme="siderTheme"
          mode="inline"
          inline-collapsed
          :items="menuItems"
          :selected-keys="selectedKeys"
          :style="menuStyle"
          @click="onMenuClick"
        />
      </div>

      <div class="layout-rail__footer app-no-drag">
        <a-menu
          :theme="siderTheme"
          mode="inline"
          inline-collapsed
          :items="footerMenuItems"
          :selected-keys="selectedKeys"
          :style="menuStyle"
          @click="onMenuClick"
        />
      </div>
    </div>
  </a-layout-sider>
</template>

<style scoped>
.layout-rail__body {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding-block-end: 8px;
}

.layout-rail__top {
  flex: none;
}

/* 主导航吃掉中间所有空间，把底部菜单顶到最下面 */
.layout-rail__nav {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

.layout-rail__footer {
  flex: none;
}
</style>
