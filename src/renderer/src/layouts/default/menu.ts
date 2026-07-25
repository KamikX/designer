import type { MenuItemType } from 'antdv-next'
import { AppstoreOutlined, HomeOutlined, MessageOutlined, SettingOutlined } from '@antdv-next/icons'

/**
 * 侧栏菜单配置。
 *
 * key 直接用路由 path，这样选中态可以由 route.path 反查，
 * 不用额外维护一张 key -> path 的映射表。
 */

/** 上半部分：主导航 */
export const MENU_ITEMS: MenuItemType[] = [
  { key: '/', icon: HomeOutlined, label: '首页' },
  { key: '/chat', icon: MessageOutlined, label: '聊天' },
  { key: '/components', icon: AppstoreOutlined, label: '组件' }
]

/** 下半部分：贴底的工具入口 */
export const FOOTER_MENU_ITEMS: MenuItemType[] = [
  { key: '/settings', icon: SettingOutlined, label: '设置' }
]
