<script setup lang="ts">
import LayoutSider from './Sider.vue'
import { DRAG_BAR_HEIGHT } from './use-layout'
</script>

<template>
  <!-- 没有顶栏：侧栏通顶，红绿灯直接落在导轨上（微信 macOS 那种形态） -->
  <a-layout class="layout-root">
    <LayoutSider />
    <!-- 内容区不能填不透明底色，否则毛玻璃全被盖住 -->
    <a-layout-content class="layout-content" :style="{ background: 'transparent' }">
      <!-- 内容区顶部的拖拽条。留在文档流里而不是浮动：浮动的话它会盖住
           下面的内容，而拖拽区吞事件、app-no-drag 又只对子节点生效，
           那一条就成了"看得见点不动"的死区 -->
      <div class="layout-content__drag app-drag" :style="{ height: `${DRAG_BAR_HEIGHT}px` }" />
      <div class="layout-content__inner">
        <router-view />
      </div>
    </a-layout-content>
  </a-layout>
</template>

<style scoped>
.layout-root {
  height: 100%;
}

.layout-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.layout-content__drag {
  flex: none;
}

/* 顶部不留 padding，上面那条拖拽条已经是那段留白了 */
.layout-content__inner {
  flex: 1;
  min-height: 0;
  padding: 0 16px 16px;
  overflow: auto;
}
</style>
