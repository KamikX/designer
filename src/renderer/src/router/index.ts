import type { RouteRecordRaw } from 'vue-router'
import { createRouter, createWebHashHistory } from 'vue-router'
import DefaultLayout from '@renderer/layouts/default/index.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    // 布局作为父路由：切换子页面时 layout 不重新挂载，
    // 侧栏折叠状态、滚动位置都能保留
    component: DefaultLayout,
    children: [
      {
        path: '',
        name: 'Home',
        component: () => import('@renderer/pages/home/index.vue')
      },
      {
        path: 'project/:id',
        name: 'Project',
        component: () => import('@renderer/pages/project/index.vue')
      },
      {
        path: 'chat',
        name: 'Chat',
        component: () => import('@renderer/pages/chat/index.vue')
      },
      {
        path: 'collab',
        name: 'Collab',
        component: () => import('@renderer/pages/collab/index.vue')
      },
      {
        path: 'market',
        name: 'Market',
        component: () => import('@renderer/pages/market/index.vue')
      },
      {
        // 「我的技能」编辑器。:name 就是技能目录名——技能没有数据库 id
        path: 'skills/:name',
        name: 'SkillEditor',
        component: () => import('@renderer/pages/skill-editor/index.vue')
      },
      {
        path: 'settings',
        name: 'Settings',
        component: () => import('@renderer/pages/settings/index.vue')
      }
    ]
  },
  {
    // 404 不套 layout，避免在坏掉的路由上还显示一圈应用外壳
    path: '/:pathMatch(.*)*',
    name: 'NotFound',
    component: () => import('@renderer/pages/not-found/index.vue')
  }
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes
})
