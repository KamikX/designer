import type { MenuItemType } from 'antdv-next'
import {
  AppstoreOutlined,
  HomeOutlined,
  LineChartOutlined,
  MessageOutlined,
  SettingOutlined,
  TeamOutlined
} from '@antdv-next/icons'

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
  { key: '/collab', icon: TeamOutlined, label: '协作' },
  // 技能和 MCP 合成一个入口的两个 tab:侧栏刚减掉一项,再加两项就白减了
  { key: '/market', icon: AppstoreOutlined, label: '市场' }
]

/** 下半部分：贴底的工具入口 */
export const FOOTER_MENU_ITEMS: MenuItemType[] = [
  // 用量是"回头看账"的工具属性入口,和设置一起贴底,不挤主导航
  { key: '/usage', icon: LineChartOutlined, label: '用量' },
  { key: '/settings', icon: SettingOutlined, label: '设置' }
]
