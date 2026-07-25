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

/*
 * 内容区不再统一加内边距，改由每个页面自己实现。
 *
 * 原因是通用 padding 只能管住"页面外框到窗口边"，管不到页面内部：对话面板
 * 的输入框左边距来自这里、右边距来自面板自己，两个来源永远对不齐。边距由
 * 页面自己从左到右一次排完，才可能对称。
 *
 * 值放在这里作为自定义属性：CSS 变量沿 DOM 继承，不受 scoped 限制，
 * 各页面引用同一个来源，改一处全体跟着走。
 */
.layout-content__inner {
  --page-pad: 16px;
  flex: 1;
  min-height: 0;
  /* 顶部不留白：上面那条拖拽条已经是那段留白了 */
  padding: 0;
  overflow: auto;
}
</style>
